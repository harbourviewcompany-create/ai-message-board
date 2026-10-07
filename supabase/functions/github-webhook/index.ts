import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { serviceClient } from '../_shared/supabase.ts'

const encoder = new TextEncoder()

function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i]
  return mismatch === 0
}

async function verifySignature(raw: string, secret: string, signature: string | null) {
  if (!signature?.startsWith('sha256=')) return false
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(raw)))
  const suppliedHex = signature.slice('sha256='.length)
  if (!/^[0-9a-f]{64}$/i.test(suppliedHex)) return false
  const supplied = new Uint8Array(suppliedHex.match(/.{2}/g)!.map((x) => Number.parseInt(x, 16)))
  return timingSafeEqual(digest, supplied)
}

function eventRef(payload: any, event: string) {
  const repo = payload.repository?.full_name ?? null
  if (!repo) return null
  if (event === 'pull_request') return { ref_type: 'pull_request', ref_number: String(payload.number), sha: payload.pull_request?.head?.sha, url: payload.pull_request?.html_url }
  if (event === 'issues') return { ref_type: 'issue', ref_number: String(payload.issue?.number ?? payload.number), url: payload.issue?.html_url }
  if (event === 'push') return { ref_type: 'commit', sha: payload.after, url: payload.head_commit?.url }
  if (event === 'workflow_run') return { ref_type: 'workflow', ref_number: String(payload.workflow_run?.id ?? ''), sha: payload.workflow_run?.head_sha, url: payload.workflow_run?.html_url }
  return null
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const secret = Deno.env.get('GITHUB_WEBHOOK_SECRET')
  if (!secret) return new Response('Webhook secret not configured', { status: 503 })

  const raw = await req.text()
  const valid = await verifySignature(raw, secret, req.headers.get('x-hub-signature-256'))
  if (!valid) return new Response('Invalid signature', { status: 401 })

  const deliveryId = req.headers.get('x-github-delivery')
  const eventName = req.headers.get('x-github-event')
  if (!deliveryId || !eventName) return new Response('Missing GitHub headers', { status: 400 })

  let payload: any
  try { payload = JSON.parse(raw) } catch { return new Response('Invalid JSON', { status: 400 }) }

  const repo = payload.repository?.full_name ?? null
  const db = serviceClient()
  let workspaceId: string | null = null

  if (repo) {
    const { data: mapping } = await db.from('github_repositories')
      .select('workspace_id')
      .ilike('full_name', repo)
      .maybeSingle()
    workspaceId = mapping?.workspace_id ?? null
  }

  const { error: eventError } = await db.from('github_events').insert({
    workspace_id: workspaceId,
    delivery_id: deliveryId,
    event_name: eventName,
    repository_full_name: repo,
    action: payload.action ?? null,
    actor: payload.sender?.login ?? null,
    payload,
  })

  if (eventError && eventError.code !== '23505') {
    console.error(eventError)
    return new Response('Database error', { status: 500 })
  }

  const ref = workspaceId ? eventRef(payload, eventName) : null
  if (ref && repo) {
    await db.from('github_refs').insert({
      workspace_id: workspaceId,
      repository_full_name: repo,
      ref_type: ref.ref_type,
      ref_number: ref.ref_number ?? null,
      sha: ref.sha ?? null,
      url: ref.url ?? null,
      metadata: { event: eventName, action: payload.action ?? null, delivery_id: deliveryId },
    })
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
