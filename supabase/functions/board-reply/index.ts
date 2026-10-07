import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { serviceClient, userClient } from '../_shared/supabase.ts'
import { compactContributions, compactGithubContext } from '../_shared/context.ts'
import { boardProviderBudget } from '../_shared/providers/budget.ts'
import {
  anthropicAdapter,
  openAIAdapter,
  xAIAdapter,
  type CouncilStrategy,
  type ProviderAdapter,
  type ReasoningEffort,
  type SharedContribution,
} from '../_shared/providers/index.ts'

const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' }
const ORDER = ['xai', 'anthropic', 'openai'] as const
type ProviderKey = typeof ORDER[number]

const AGENT_NAME: Record<ProviderKey, string> = {
  xai: 'Grok',
  anthropic: 'Claude',
  openai: 'ChatGPT',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders })
}

function isProviderKey(value: unknown): value is ProviderKey {
  return value === 'xai' || value === 'anthropic' || value === 'openai'
}

function effortFor(strategy: CouncilStrategy): ReasoningEffort {
  if (strategy === 'quality' || strategy === 'adversarial') return 'high'
  if (strategy === 'fast' || strategy === 'economy') return 'low'
  return 'medium'
}

function configuredAdapters(settings: any): Record<ProviderKey, ProviderAdapter | null> {
  const { timeoutMs, maxRetries } = boardProviderBudget(settings)
  const effort = effortFor((settings.strategy ?? 'balanced') as CouncilStrategy)

  return {
    openai: settings.enable_openai
      ? openAIAdapter({ model: settings.openai_model ?? 'gpt-6.1-sol', timeoutMs, maxRetries, effort })
      : null,
    anthropic: settings.enable_anthropic
      ? anthropicAdapter({ model: settings.anthropic_model ?? 'claude-sonnet-5-5', timeoutMs, maxRetries, effort })
      : null,
    xai: settings.enable_xai
      ? xAIAdapter({ model: settings.xai_model ?? 'grok-4.7', timeoutMs, maxRetries, effort })
      : null,
  }
}

function pickNext(
  history: Array<{ provider?: string | null }>,
  adapters: Record<ProviderKey, ProviderAdapter | null>,
): ProviderKey | null {
  const lastAgent = [...history].reverse().find((row) => isProviderKey(row.provider))
  const start = lastAgent ? (ORDER.indexOf(lastAgent.provider as ProviderKey) + 1) % ORDER.length : 0

  for (let offset = 0; offset < ORDER.length; offset++) {
    const key = ORDER[(start + offset) % ORDER.length]
    const adapter = adapters[key]
    if (adapter?.configured) return key
  }
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authorization = req.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Missing bearer token' }, 401)

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }

  const threadId = body.thread_id
  if (typeof threadId !== 'string' || !threadId) return json({ error: 'thread_id is required' }, 400)
  if (body.provider !== undefined && !isProviderKey(body.provider)) {
    return json({ error: "provider must be one of 'openai' | 'anthropic' | 'xai'" }, 400)
  }

  const caller = userClient(authorization)
  const token = authorization.slice('Bearer '.length)
  const { data: authData, error: authError } = await caller.auth.getUser(token)
  if (authError || !authData.user) return json({ error: 'Unauthorized' }, 401)

  const { data: thread, error: threadError } = await caller
    .from('threads')
    .select('id, workspace_id, title, objective, mode')
    .eq('id', threadId)
    .single()

  if (threadError || !thread) return json({ error: 'Thread not found or forbidden' }, 404)
  if (thread.mode !== 'board') return json({ error: 'Thread is not in board mode' }, 409)

  const { data: settingsRow } = await caller
    .from('workspace_settings')
    .select('*')
    .eq('workspace_id', thread.workspace_id)
    .maybeSingle()

  const settings = settingsRow ?? {
    strategy: 'balanced',
    enable_openai: true,
    enable_anthropic: true,
    enable_xai: true,
    openai_model: 'gpt-6.1-sol',
    anthropic_model: 'claude-sonnet-5-5',
    xai_model: 'grok-4.7',
    max_context_contributions: 18,
    max_context_chars: 18000,
    provider_timeout_ms: 30000,
    max_retries: 0,
    board_stale_after_seconds: 300,
  }

  const db = serviceClient()
  const historyLimit = Number(settings.max_context_contributions ?? 18)
  const maxContextChars = Number(settings.max_context_chars ?? 18000)

  const [{ data: rows, error: historyError }, { data: githubRefs }] = await Promise.all([
    db.from('contributions')
      .select('agent, provider, model, kind, round, summary, assumptions, evidence, recommendations, disagreements, confidence, created_at')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: false })
      .limit(historyLimit),
    db.from('github_refs')
      .select('repository_full_name, ref_type, ref_number, sha, path, url, metadata')
      .eq('workspace_id', thread.workspace_id)
      .order('created_at', { ascending: false })
      .limit(20),
  ])

  if (historyError) return json({ error: `Failed to load history: ${historyError.message}` }, 500)
  const history = [...(rows ?? [])].reverse()

  const available = configuredAdapters(settings)
  const requestedProvider = isProviderKey(body.provider) ? body.provider : null

  if (requestedProvider && !available[requestedProvider]) {
    return json({ error: `${AGENT_NAME[requestedProvider]} is disabled in workspace settings` }, 409)
  }

  const providerKey = requestedProvider ?? pickNext(history, available)
  if (!providerKey) return json({ error: 'No enabled provider has an API key configured' }, 503)

  const adapter = available[providerKey]!
  if (!adapter.configured) return json({ error: `${AGENT_NAME[providerKey]} API key is not configured` }, 409)

  const staleSeconds = Math.max(60, Math.min(1800, Number(settings.board_stale_after_seconds ?? 300)))
  const staleBefore = new Date(Date.now() - staleSeconds * 1000).toISOString()
  await db.from('agent_runs')
    .update({
      status: 'failed',
      error: 'Board reply exceeded the stale-run guard',
      completed_at: new Date().toISOString(),
    })
    .eq('thread_id', threadId)
    .eq('phase', 'message')
    .eq('status', 'running')
    .lt('started_at', staleBefore)

  const requestKey =
    typeof body.idempotency_key === 'string' && body.idempotency_key.trim()
      ? body.idempotency_key.trim().slice(0, 200)
      : crypto.randomUUID()

  const { data: sameRun } = await db.from('agent_runs')
    .select('id, status, contribution_id, provider, model, error')
    .eq('thread_id', threadId)
    .eq('request_key', requestKey)
    .maybeSingle()

  if (sameRun) {
    const status = sameRun.status === 'running' ? 202 : 200
    return json({ ok: sameRun.status !== 'failed', reused: true, run: sameRun }, status)
  }

  const { data: run, error: runError } = await db.from('agent_runs').insert({
    thread_id: threadId,
    provider: providerKey,
    model: adapter.model,
    phase: 'message',
    status: 'running',
    request_key: requestKey,
    input_summary: `[board reply] ${AGENT_NAME[providerKey]} in "${thread.title ?? ''}"`.slice(0, 500),
    started_at: new Date().toISOString(),
  }).select('id, status, contribution_id').single()

  if (runError) {
    if (runError.code === '23505') {
      const { data: activeRun } = await db.from('agent_runs')
        .select('id, status, contribution_id, provider, model, error, request_key')
        .eq('thread_id', threadId)
        .eq('phase', 'message')
        .eq('status', 'running')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (activeRun) return json({ ok: true, reused: true, run: activeRun }, 202)
    }
    return json({ error: `Failed to record run: ${runError.message}` }, 500)
  }

  try {
    const existing = compactContributions(history.map((row: any) => ({
      agent: row.agent ?? 'Human',
      provider: row.provider ?? null,
      model: row.model ?? null,
      kind: row.kind ?? 'message',
      round: row.round ?? 0,
      summary: row.summary ?? '',
      assumptions: Array.isArray(row.assumptions) ? row.assumptions : [],
      evidence: Array.isArray(row.evidence) ? row.evidence : [],
      recommendations: Array.isArray(row.recommendations) ? row.recommendations : [],
      disagreements: Array.isArray(row.disagreements) ? row.disagreements : [],
      confidence: row.confidence ?? null,
    })) as SharedContribution[], maxContextChars)
    const githubContext = compactGithubContext(githubRefs ?? [])

    const result = await adapter.run({
      threadId,
      runId: run.id,
      phase: 'message',
      strategy: (settings.strategy ?? 'balanced') as CouncilStrategy,
      title: thread.title ?? 'Board thread',
      objective: thread.objective ?? '',
      existing,
      githubContext,
    })

    const message = result.normalized.summary?.trim()
    if (!message) throw new Error('Provider returned an empty reply')

    const { data: contribution, error: insertError } = await db.from('contributions').insert({
      thread_id: threadId,
      agent: AGENT_NAME[providerKey],
      provider: result.provider,
      model: result.model,
      kind: 'message',
      round: 0,
      summary: message,
      assumptions: [],
      evidence: [],
      recommendations: [],
      disagreements: [],
      confidence: null,
      metadata: { board_reply: true, request_key: requestKey },
    }).select('id').single()

    if (insertError || !contribution) throw new Error(`Insert failed: ${insertError?.message ?? 'unknown'}`)

    await db.from('agent_runs').update({
      status: 'complete',
      contribution_id: contribution.id,
      usage: result.usage ?? {},
      completed_at: new Date().toISOString(),
    }).eq('id', run.id)

    return json({
      ok: true,
      contribution_id: contribution.id,
      agent: AGENT_NAME[providerKey],
      provider: result.provider,
      model: result.model,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db.from('agent_runs').update({
      status: 'failed',
      error: message.slice(0, 5000),
      completed_at: new Date().toISOString(),
    }).eq('id', run.id)

    return json({ ok: false, error: message, provider: providerKey }, 502)
  }
})
