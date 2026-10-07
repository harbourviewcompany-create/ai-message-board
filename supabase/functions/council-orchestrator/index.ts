import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { serviceClient, userClient } from '../_shared/supabase.ts'
import { anthropicAdapter, openAIAdapter, xAIAdapter, type Phase, type ProviderAdapter, type SharedContribution } from '../_shared/providers/index.ts'

const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' }

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders })
}

function contributionRow(threadId: string, phase: Phase, round: number, result: any) {
  return {
    thread_id: threadId,
    agent: result.provider === 'anthropic' ? 'Claude' : result.provider === 'xai' ? 'Grok' : 'ChatGPT',
    provider: result.provider,
    model: result.model,
    kind: phase === 'proposal' ? 'proposal' : phase === 'critique' ? 'critique' : 'synthesis',
    round,
    summary: result.normalized.summary,
    assumptions: result.normalized.assumptions,
    evidence: result.normalized.evidence,
    recommendations: result.normalized.recommendations,
    disagreements: result.normalized.disagreements,
    confidence: result.normalized.confidence,
  }
}

async function runPhase(
  db: ReturnType<typeof serviceClient>,
  thread: any,
  phase: Phase,
  round: number,
  adapters: ProviderAdapter[],
  existing: SharedContribution[],
  githubContext: unknown[],
) {
  const configured = adapters.filter((a) => a.configured)
  const skipped = adapters.filter((a) => !a.configured)

  if (skipped.length) {
    await db.from('agent_runs').insert(skipped.map((a) => ({
      thread_id: thread.id,
      provider: a.name,
      model: a.model,
      phase,
      status: 'skipped',
      error: 'API key not configured',
      completed_at: new Date().toISOString(),
    })))
  }

  const jobs = configured.map(async (adapter) => {
    const startedAt = new Date().toISOString()
    const { data: run, error: runError } = await db.from('agent_runs').insert({
      thread_id: thread.id,
      provider: adapter.name,
      model: adapter.model,
      phase,
      status: 'running',
      input_summary: `${thread.title}: ${thread.objective.slice(0, 500)}`,
      started_at: startedAt,
    }).select('id').single()
    if (runError) throw runError

    try {
      const result = await adapter.run({
        phase,
        title: thread.title,
        objective: thread.objective,
        existing,
        githubContext,
      })
      const { data: contribution, error: contributionError } = await db
        .from('contributions')
        .insert(contributionRow(thread.id, phase, round, result))
        .select('*')
        .single()
      if (contributionError) throw contributionError

      await db.from('agent_runs').update({
        status: 'complete',
        contribution_id: contribution.id,
        usage: result.usage,
        completed_at: new Date().toISOString(),
      }).eq('id', run.id)

      return contribution
    } catch (error) {
      await db.from('agent_runs').update({
        status: 'failed',
        error: error instanceof Error ? error.message.slice(0, 5000) : String(error),
        completed_at: new Date().toISOString(),
      }).eq('id', run.id)
      return null
    }
  })

  return (await Promise.all(jobs)).filter(Boolean)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authorization = req.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Missing bearer token' }, 401)

  let body: any
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }
  const threadId = body?.thread_id
  if (!threadId) return json({ error: 'thread_id is required' }, 400)

  const caller = userClient(authorization)
  const token = authorization.slice('Bearer '.length)
  const { data: authData, error: authError } = await caller.auth.getUser(token)
  if (authError || !authData.user) return json({ error: 'Unauthorized' }, 401)

  const { data: thread, error: threadError } = await caller
    .from('threads')
    .select('id, workspace_id, title, objective, status')
    .eq('id', threadId)
    .single()
  if (threadError || !thread) return json({ error: 'Thread not found or forbidden' }, 404)

  const db = serviceClient()
  const { data: existingRows } = await db.from('contributions')
    .select('agent, provider, model, kind, round, summary, assumptions, evidence, recommendations, disagreements, confidence')
    .eq('thread_id', thread.id)
    .order('created_at', { ascending: true })
    .limit(60)

  const { data: refs } = await db.from('github_refs')
    .select('repository_full_name, ref_type, ref_number, sha, path, url, metadata')
    .eq('workspace_id', thread.workspace_id)
    .order('created_at', { ascending: false })
    .limit(30)

  await db.from('threads').update({ status: 'running', current_round: 1 }).eq('id', thread.id)

  const adapters = [openAIAdapter(), anthropicAdapter(), xAIAdapter()]
  if (!adapters.some((a) => a.configured)) {
    await db.from('threads').update({ status: 'failed' }).eq('id', thread.id)
    return json({ error: 'No provider API keys are configured' }, 503)
  }

  const baseExisting = (existingRows ?? []) as SharedContribution[]
  const proposals = await runPhase(db, thread, 'proposal', 1, adapters, baseExisting, refs ?? [])
  if (!proposals.length) {
    await db.from('threads').update({ status: 'failed', current_round: 1 }).eq('id', thread.id)
    return json({ error: 'All providers failed during proposal phase' }, 502)
  }

  await db.from('threads').update({ current_round: 2 }).eq('id', thread.id)
  const critiqueContext = [...baseExisting, ...proposals] as SharedContribution[]
  const critiques = await runPhase(db, thread, 'critique', 2, adapters, critiqueContext, refs ?? [])

  await db.from('threads').update({ current_round: 3 }).eq('id', thread.id)
  const synthesisAdapter = adapters.find((a) => a.name === 'openai' && a.configured) ?? adapters.find((a) => a.configured)!
  const synthesisContext = [...critiqueContext, ...critiques] as SharedContribution[]
  const synthesis = await runPhase(db, thread, 'synthesis', 3, [synthesisAdapter], synthesisContext, refs ?? [])

  if (!synthesis.length) {
    await db.from('threads').update({ status: 'failed', current_round: 3 }).eq('id', thread.id)
    return json({ error: 'Synthesis failed', proposals: proposals.length, critiques: critiques.length }, 502)
  }

  const final = synthesis[0]
  await db.from('decisions').insert({
    thread_id: thread.id,
    decision: final.summary,
    rationale: [
      ...(Array.isArray(final.recommendations) ? final.recommendations : []),
      ...(Array.isArray(final.disagreements) ? final.disagreements.map((x: string) => `Dissent: ${x}`) : []),
    ].join('\n'),
    supporting_contributions: proposals.map((p: any) => p.id),
    dissenting_contributions: critiques.map((c: any) => c.id),
  })

  await db.from('threads').update({ status: 'complete', current_round: 3 }).eq('id', thread.id)
  return json({
    ok: true,
    thread_id: thread.id,
    proposals: proposals.length,
    critiques: critiques.length,
    synthesis_id: final.id,
  })
})
