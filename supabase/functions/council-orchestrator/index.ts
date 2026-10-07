import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { serviceClient, userClient } from '../_shared/supabase.ts'
import {
  anthropicAdapter,
  openAIAdapter,
  xAIAdapter,
  type CouncilStrategy,
  type Phase,
  type ProviderAdapter,
  type ReasoningEffort,
  type SharedContribution,
} from '../_shared/providers/index.ts'

const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' }

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders })
}

function effortFor(strategy: CouncilStrategy, phase: Phase): ReasoningEffort {
  if (strategy === 'economy' || strategy === 'fast') return phase === 'synthesis' ? 'medium' : 'low'
  if (strategy === 'quality' || strategy === 'adversarial') return 'high'
  return phase === 'synthesis' ? 'high' : 'medium'
}

function contributionRow(runId: string, threadId: string, phase: Phase, round: number, result: any) {
  return {
    run_id: runId,
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
  runId: string,
  thread: any,
  phase: Phase,
  round: number,
  adapters: ProviderAdapter[],
  existing: SharedContribution[],
  githubContext: unknown[],
  strategy: CouncilStrategy,
) {
  const configured = adapters.filter((a) => a.configured)
  const skipped = adapters.filter((a) => !a.configured)

  if (skipped.length) {
    await db.from('agent_runs').insert(skipped.map((a) => ({
      run_id: runId,
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
    const { data: run, error: runError } = await db.from('agent_runs').insert({
      run_id: runId,
      thread_id: thread.id,
      provider: adapter.name,
      model: adapter.model,
      phase,
      status: 'running',
      input_summary: `${thread.title}: ${thread.objective.slice(0, 500)}`,
      started_at: new Date().toISOString(),
    }).select('id').single()
    if (runError) throw runError

    try {
      const result = await adapter.run({
        threadId: thread.id,
        runId,
        phase,
        strategy,
        title: thread.title,
        objective: thread.objective,
        existing,
        githubContext,
      })

      const { data: contribution, error: contributionError } = await db
        .from('contributions')
        .insert(contributionRow(runId, thread.id, phase, round, result))
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

function buildAdapters(settings: any, phase: Phase, strategy: CouncilStrategy) {
  const effort = effortFor(strategy, phase)
  const timeoutMs = Number(settings.provider_timeout_ms ?? 35000)
  const maxRetries = Number(settings.max_retries ?? 1)

  const openAIModel = phase === 'synthesis'
    ? (strategy === 'economy' || strategy === 'fast'
      ? settings.openai_model
      : settings.openai_synthesis_model)
    : strategy === 'quality' || strategy === 'adversarial'
      ? settings.openai_synthesis_model
      : strategy === 'economy'
        ? 'gpt-6-luna'
        : settings.openai_model

  const adapters: ProviderAdapter[] = []
  if (settings.enable_openai) adapters.push(openAIAdapter({ model: openAIModel, timeoutMs, maxRetries, effort }))
  if (settings.enable_anthropic) adapters.push(anthropicAdapter({ model: settings.anthropic_model, timeoutMs, maxRetries, effort }))
  if (settings.enable_xai) adapters.push(xAIAdapter({ model: settings.xai_model, timeoutMs, maxRetries, effort }))
  return adapters
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authorization = req.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Missing bearer token' }, 401)

  const caller = userClient(authorization)
  const token = authorization.slice('Bearer '.length)
  const { data: authData, error: authError } = await caller.auth.getUser(token)
  if (authError || !authData.user) return json({ error: 'Unauthorized' }, 401)

  let body: any
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }

  if (body?.action === 'health') {
    return json({
      ok: true,
      providers: {
        openai: { configured: Boolean(Deno.env.get('OPENAI_API_KEY')), default_model: Deno.env.get('OPENAI_MODEL') ?? 'gpt-6.1-sol' },
        anthropic: { configured: Boolean(Deno.env.get('ANTHROPIC_API_KEY')), default_model: Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-sonnet-5' },
        xai: { configured: Boolean(Deno.env.get('XAI_API_KEY')), default_model: Deno.env.get('XAI_MODEL') ?? 'grok-4.7' },
      },
      github_webhook: { configured: Boolean(Deno.env.get('GITHUB_WEBHOOK_SECRET')) },
    })
  }

  const threadId = body?.thread_id
  if (!threadId) return json({ error: 'thread_id is required' }, 400)

  const { data: thread, error: threadError } = await caller
    .from('threads')
    .select('id, workspace_id, title, objective, status')
    .eq('id', threadId)
    .single()
  if (threadError || !thread) return json({ error: 'Thread not found or forbidden' }, 404)

  const { data: settingsRow } = await caller
    .from('workspace_settings')
    .select('*')
    .eq('workspace_id', thread.workspace_id)
    .maybeSingle()

  const settings = settingsRow ?? {
    strategy: 'balanced',
    require_human_approval: true,
    enable_openai: true,
    enable_anthropic: true,
    enable_xai: true,
    openai_model: 'gpt-6.1-sol',
    openai_synthesis_model: 'gpt-6-astra',
    anthropic_model: 'claude-sonnet-5',
    xai_model: 'grok-4.7',
    max_context_contributions: 30,
    provider_timeout_ms: 35000,
    max_retries: 1,
  }

  const strategy = (body?.strategy ?? settings.strategy ?? 'balanced') as CouncilStrategy
  const db = serviceClient()

  const staleBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString()
  await db.from('council_runs')
    .update({
      status: 'failed',
      error: 'Run exceeded the 15-minute stale-run guard',
      completed_at: new Date().toISOString(),
    })
    .eq('thread_id', thread.id)
    .in('status', ['queued', 'running'])
    .lt('updated_at', staleBefore)

  const idempotencyKey = typeof body?.idempotency_key === 'string' && body.idempotency_key.trim()
    ? body.idempotency_key.trim().slice(0, 200)
    : crypto.randomUUID()

  const providerNames = [
    settings.enable_openai ? 'openai' : null,
    settings.enable_anthropic ? 'anthropic' : null,
    settings.enable_xai ? 'xai' : null,
  ].filter(Boolean)

  const { data: councilRun, error: createRunError } = await db.from('council_runs').insert({
    thread_id: thread.id,
    requested_by: authData.user.id,
    idempotency_key: idempotencyKey,
    status: 'running',
    strategy,
    providers: providerNames,
    current_phase: 'proposal',
    started_at: new Date().toISOString(),
  }).select('*').single()

  if (createRunError) {
    if (createRunError.code === '23505') {
      const { data: existingRun } = await db.from('council_runs')
        .select('*')
        .eq('thread_id', thread.id)
        .in('status', ['queued', 'running'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      return json({ ok: true, reused: true, run: existingRun }, 202)
    }
    return json({ error: createRunError.message }, 500)
  }

  const runId = councilRun.id

  try {
    const limit = Number(settings.max_context_contributions ?? 30)
    const { data: existingRows } = await db.from('contributions')
      .select('agent, provider, model, kind, round, summary, assumptions, evidence, recommendations, disagreements, confidence')
      .eq('thread_id', thread.id)
      .order('created_at', { ascending: false })
      .limit(limit)

    const { data: refs } = await db.from('github_refs')
      .select('repository_full_name, ref_type, ref_number, sha, path, url, metadata')
      .eq('workspace_id', thread.workspace_id)
      .order('created_at', { ascending: false })
      .limit(30)

    await db.from('threads').update({ status: 'running', current_round: 1 }).eq('id', thread.id)

    const proposalAdapters = buildAdapters(settings, 'proposal', strategy)
    if (!proposalAdapters.some((a) => a.configured)) {
      await db.from('council_runs').update({
        status: 'failed',
        error: 'No provider API keys are configured',
        completed_at: new Date().toISOString(),
      }).eq('id', runId)
      await db.from('threads').update({ status: 'failed' }).eq('id', thread.id)
      return json({ error: 'No provider API keys are configured', run_id: runId }, 503)
    }

    const baseExisting = [...(existingRows ?? [])].reverse() as SharedContribution[]
    const proposals = await runPhase(db, runId, thread, 'proposal', 1, proposalAdapters, baseExisting, refs ?? [], strategy)
    if (!proposals.length) throw new Error('All configured providers failed during proposal phase')

    await db.from('council_runs').update({ current_phase: 'critique' }).eq('id', runId)
    await db.from('threads').update({ current_round: 2 }).eq('id', thread.id)

    const critiqueContext = [...baseExisting, ...proposals] as SharedContribution[]
    const critiques = await runPhase(
      db,
      runId,
      thread,
      'critique',
      2,
      buildAdapters(settings, 'critique', strategy),
      critiqueContext,
      refs ?? [],
      strategy,
    )

    await db.from('council_runs').update({ current_phase: 'synthesis' }).eq('id', runId)
    await db.from('threads').update({ current_round: 3 }).eq('id', thread.id)

    const synthesisAdapters = buildAdapters(settings, 'synthesis', strategy)
    const synthesisAdapter =
      synthesisAdapters.find((a) => a.name === 'openai' && a.configured) ??
      synthesisAdapters.find((a) => a.name === 'anthropic' && a.configured) ??
      synthesisAdapters.find((a) => a.configured)

    if (!synthesisAdapter) throw new Error('No provider is available for synthesis')

    const synthesisContext = [...critiqueContext, ...critiques] as SharedContribution[]
    const synthesis = await runPhase(
      db,
      runId,
      thread,
      'synthesis',
      3,
      [synthesisAdapter],
      synthesisContext,
      refs ?? [],
      strategy,
    )
    if (!synthesis.length) throw new Error('Synthesis failed')

    const final: any = synthesis[0]
    const requiresApproval = Boolean(settings.require_human_approval)
    const { data: decision, error: decisionError } = await db.from('decisions').insert({
      run_id: runId,
      thread_id: thread.id,
      decision: final.summary,
      rationale: [
        ...(Array.isArray(final.recommendations) ? final.recommendations : []),
        ...(Array.isArray(final.disagreements) ? final.disagreements.map((x: string) => `Dissent: ${x}`) : []),
      ].join('\n'),
      supporting_contributions: proposals.map((p: any) => p.id),
      dissenting_contributions: critiques.map((c: any) => c.id),
      status: requiresApproval ? 'proposed' : 'accepted',
    }).select('*').single()
    if (decisionError) throw decisionError

    const metrics = {
      proposals: proposals.length,
      critiques: critiques.length,
      synthesis: synthesis.length,
      providers_requested: providerNames,
      synthesis_provider: synthesisAdapter.name,
      synthesis_model: synthesisAdapter.model,
    }

    if (requiresApproval) {
      await db.from('council_runs').update({
        status: 'awaiting_approval',
        current_phase: 'approval',
        metrics,
      }).eq('id', runId)
      await db.from('threads').update({ status: 'awaiting_approval', current_round: 3 }).eq('id', thread.id)
    } else {
      await db.from('council_runs').update({
        status: 'complete',
        current_phase: 'approval',
        metrics,
        completed_at: new Date().toISOString(),
      }).eq('id', runId)
      await db.from('threads').update({ status: 'complete', current_round: 3 }).eq('id', thread.id)
    }

    return json({
      ok: true,
      run_id: runId,
      decision_id: decision.id,
      awaiting_approval: requiresApproval,
      ...metrics,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db.from('council_runs').update({
      status: 'failed',
      error: message.slice(0, 5000),
      completed_at: new Date().toISOString(),
    }).eq('id', runId)
    await db.from('threads').update({ status: 'failed' }).eq('id', thread.id)
    return json({ error: message, run_id: runId }, 502)
  }
})
