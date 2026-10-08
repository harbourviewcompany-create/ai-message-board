import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { serviceClient } from '../_shared/supabase.ts'
import { githubEventRef, normalizeGithubPayload } from '../_shared/github.ts'

const encoder = new TextEncoder()
const MAX_WEBHOOK_BYTES = 2_000_000

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
  const supplied = new Uint8Array(suppliedHex.match(/.{2}/g)!.map((hex) => Number.parseInt(hex, 16)))
  return timingSafeEqual(digest, supplied)
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const secret = Deno.env.get('GITHUB_WEBHOOK_SECRET')
  if (!secret) return new Response('Webhook secret not configured', { status: 503 })

  const declaredLength = Number(req.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_WEBHOOK_BYTES) return new Response('Payload too large', { status: 413 })

  const raw = await req.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_WEBHOOK_BYTES) return new Response('Payload too large', { status: 413 })

  const valid = await verifySignature(raw, secret, req.headers.get('x-hub-signature-256'))
  if (!valid) return new Response('Invalid signature', { status: 401 })

  const deliveryId = req.headers.get('x-github-delivery')
  const eventName = req.headers.get('x-github-event')
  if (!deliveryId || !eventName) return new Response('Missing GitHub headers', { status: 400 })
  if (!/^[a-z0-9_]+$/i.test(eventName)) return new Response('Invalid GitHub event name', { status: 400 })

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

  const normalizedPayload = normalizeGithubPayload(payload, eventName)
  const { error: eventError } = await db.from('github_events').insert({
    workspace_id: workspaceId,
    delivery_id: deliveryId,
    event_name: eventName,
    repository_full_name: repo,
    action: payload.action ?? null,
    actor: payload.sender?.login ?? null,
    payload: normalizedPayload,
  })

  if (eventError?.code === '23505') {
    return new Response(JSON.stringify({ ok: true, deduplicated: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }

  if (eventError) {
    console.error(eventError)
    return new Response('Database error', { status: 500 })
  }

  const ref = workspaceId ? githubEventRef(payload, eventName) : null
  if (ref && repo) {
    const { error: refError } = await db.from('github_refs').insert({
      workspace_id: workspaceId,
      repository_full_name: repo,
      ref_type: ref.ref_type,
      ref_number: ref.ref_number ?? null,
      sha: ref.sha ?? null,
      url: ref.url ?? null,
      metadata: { event: eventName, action: payload.action ?? null, delivery_id: deliveryId },
    })
    if (refError) console.error(refError)
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
