import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { serviceClient, userClient } from '../_shared/supabase.ts'
import {
  anthropicAdapter,
  openAIAdapter,
  xAIAdapter,
  type ProviderAdapter,
  type SharedContribution,
} from '../_shared/providers/index.ts'

// Board mode: one free-form message from one model, appended to the thread.
// v1 limitation: adapters only expose proposal/critique/synthesis prompts, so
// we call run() with phase 'proposal', steer via `objective`, and store
// normalized.summary as the message. Upgrade path: add a plain-text 'message'
// phase to adapters and to agent_runs.phase check constraint.

const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' }

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders })
}

type ProviderKey = 'xai' | 'anthropic' | 'openai'

// Rotation order: Grok -> Claude -> ChatGPT
const ORDER: ProviderKey[] = ['xai', 'anthropic', 'openai']
const AGENT_NAME: Record<ProviderKey, string> = {
  xai: 'Grok',
  anthropic: 'Claude',
  openai: 'ChatGPT',
}
const HISTORY_LIMIT = 30
// Phase recorded in agent_runs. Keep 'proposal' until a migration allows 'message'.
const RUN_PHASE = 'proposal' as const

function isProviderKey(v: unknown): v is ProviderKey {
  return v === 'xai' || v === 'anthropic' || v === 'openai'
}

function adapters(): Record<ProviderKey, ProviderAdapter> {
  return {
    xai: xAIAdapter(),
    anthropic: anthropicAdapter(),
    openai: openAIAdapter(),
  }
}

/** Next speaker: continue the ring after the most recent agent message.
 *  If no agent has spoken yet, start with Grok. Unconfigured providers are skipped. */
function pickNext(
  history: Array<{ provider?: string | null }>,
  available: Record<ProviderKey, ProviderAdapter>,
): ProviderKey | null {
  const lastAgent = [...history].reverse().find((r) => isProviderKey(r.provider))
  const startIdx = lastAgent ? (ORDER.indexOf(lastAgent.provider as ProviderKey) + 1) % ORDER.length : 0
  for (let i = 0; i < ORDER.length; i++) {
    const key = ORDER[(startIdx + i) % ORDER.length]
    if (available[key].configured) return key
  }
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authorization = req.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Missing bearer token' }, 401)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const threadId = body?.thread_id
  if (typeof threadId !== 'string' || !threadId) {
    return json({ error: 'thread_id is required' }, 400)
  }
  if (body?.provider !== undefined && !isProviderKey(body.provider)) {
    return json({ error: "provider must be one of 'openai' | 'anthropic' | 'xai'" }, 400)
  }

  const caller = userClient(authorization)
  const token = authorization.slice('Bearer '.length)
  const { data: authData, error: authError } = await caller.auth.getUser(token)
  if (authError || !authData.user) return json({ error: 'Unauthorized' }, 401)

  // RLS-bound read: proves the caller can see this thread.
  const { data: thread, error: threadError } = await caller
    .from('threads')
    .select('id, workspace_id, title, objective, status, mode')
    .eq('id', threadId)
    .single()
  if (threadError || !thread) return json({ error: 'Thread not found or forbidden' }, 404)
  if (thread.mode !== 'board') {
    return json({ error: 'Thread is not in board mode (use council-orchestrator)' }, 409)
  }

  const db = serviceClient()

  // Recent history, oldest first.
  const { data: rows, error: histError } = await db
    .from('contributions')
    .select(
      'agent, provider, model, kind, round, summary, assumptions, evidence, recommendations, disagreements, confidence, created_at',
    )
    .eq('thread_id', threadId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT)
  if (histError) return json({ error: `Failed to load history: ${histError.message}` }, 500)
  const history = (rows ?? []).reverse()

  const available = adapters()
  const providerKey: ProviderKey | null = isProviderKey(body.provider)
    ? body.provider
    : pickNext(history, available)
  if (!providerKey) return json({ error: 'No providers configured' }, 503)

  const adapter = available[providerKey]
  const agent = AGENT_NAME[providerKey]
  const round =
    history.reduce((max: number, r: { round?: number | null }) => Math.max(max, r.round ?? 0), 0) || 1

  const inputSummary = `[board reply] ${agent} responding in thread "${thread.title ?? ''}"`.slice(0, 500)

  const { data: run, error: runError } = await db
    .from('agent_runs')
    .insert({
      thread_id: threadId,
      provider: providerKey,
      model: adapter.model,
      phase: RUN_PHASE,
      status: 'running',
      input_summary: inputSummary,
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (runError || !run) {
    return json({ error: `Failed to record run: ${runError?.message}` }, 500)
  }

  if (!adapter.configured) {
    await db
      .from('agent_runs')
      .update({
        status: 'skipped',
        error: 'API key not configured',
        completed_at: new Date().toISOString(),
      })
      .eq('id', run.id)
    return json({ error: `${agent} is not configured`, provider: providerKey }, 409)
  }

  try {
    const existing: SharedContribution[] = history.map((r: Record<string, unknown>) => ({
      agent: (r.agent as string) ?? 'Human',
      provider: (r.provider as string | null) ?? null,
      model: (r.model as string | null) ?? null,
      kind: (r.kind as string) ?? 'message',
      round: (r.round as number) ?? 0,
      summary: (r.summary as string) ?? '',
      assumptions: Array.isArray(r.assumptions) ? (r.assumptions as string[]) : [],
      evidence: Array.isArray(r.evidence) ? (r.evidence as string[]) : [],
      recommendations: Array.isArray(r.recommendations) ? (r.recommendations as string[]) : [],
      disagreements: Array.isArray(r.disagreements) ? (r.disagreements as string[]) : [],
      confidence: (r.confidence as number | null) ?? null,
    }))

    const objective = [
      `You are ${agent}, one participant in a shared chat between humans and several AI models.`,
      'Reply to the latest messages as a single conversational message: concise, direct, no headings.',
      'Put your entire reply in `summary`. Leave the other fields empty unless truly needed.',
      'Do not repeat what others already said; add something new or respond to a specific point.',
      thread.objective ? `Thread topic: ${thread.objective}` : '',
    ]
      .filter(Boolean)
      .join('\n')

    const result = await adapter.run({
      phase: 'proposal',
      title: thread.title ?? 'Board thread',
      objective,
      existing,
      githubContext: [],
    })

    const text = result.normalized.summary?.trim()
    if (!text) throw new Error('Provider returned an empty reply')

    const { data: contribution, error: insertError } = await db
      .from('contributions')
      .insert({
        thread_id: threadId,
        agent,
        provider: result.provider,
        model: result.model,
        kind: 'message',
        round,
        summary: text,
        assumptions: [],
        evidence: [],
        recommendations: [],
        disagreements: [],
        confidence: null,
      })
      .select('id')
      .single()
    if (insertError || !contribution) {
      throw new Error(`Insert failed: ${insertError?.message}`)
    }

    await db
      .from('agent_runs')
      .update({
        status: 'complete',
        contribution_id: contribution.id,
        usage: result.usage ?? {},
        completed_at: new Date().toISOString(),
      })
      .eq('id', run.id)

    return json({
      ok: true,
      contribution_id: contribution.id,
      agent,
      provider: result.provider,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db
      .from('agent_runs')
      .update({
        status: 'failed',
        error: message.slice(0, 5000),
        completed_at: new Date().toISOString(),
      })
      .eq('id', run.id)
    return json({ ok: false, error: message, agent, provider: providerKey }, 502)
  }
})
