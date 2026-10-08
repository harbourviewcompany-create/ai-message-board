import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { serviceClient, userClient } from '../_shared/supabase.ts'
import { compactContributions, compactEvidenceContext, compactGithubContext, compactMemoryContext, compactTaskContext } from '../_shared/context.ts'
import { councilProviderBudget } from '../_shared/providers/budget.ts'
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
  memoryContext: unknown[],
  taskContext: unknown[],
  evidenceContext: unknown[],
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
        memoryContext,
        taskContext,
        evidenceContext,
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
  const { timeoutMs, maxRetries } = councilProviderBudget(settings, strategy)

  const openAIModel = phase === 'synthesis'
    ? (strategy === 'economy' || strategy === 'fast'
      ? (settings.openai_economy_model ?? 'gpt-6-luna')
      : settings.openai_synthesis_model)
    : strategy === 'quality' || strategy === 'adversarial'
      ? settings.openai_synthesis_model
      : strategy === 'economy'
        ? (settings.openai_economy_model ?? 'gpt-6-luna')
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
        openai: { configured: Boolean(Deno.env.get('OPENAI_API_KEY')), default_model: 'gpt-6.1-sol' },
        anthropic: { configured: Boolean(Deno.env.get('ANTHROPIC_API_KEY')), default_model: 'claude-sonnet-5-5' },
        xai: { configured: Boolean(Deno.env.get('XAI_API_KEY')), default_model: 'grok-4.7' },
      },
      github_webhook: { configured: Boolean(Deno.env.get('GITHUB_WEBHOOK_SECRET')) },
    })
  }

  if (body?.action === 'diagnostics') {
    const workspaceId = typeof body?.workspace_id === 'string' ? body.workspace_id : ''
    if (!workspaceId) return json({ error: 'workspace_id is required' }, 400)

    const { data: workspace, error: workspaceError } = await caller
      .from('workspaces')
      .select('id, name')
      .eq('id', workspaceId)
      .single()

    if (workspaceError || !workspace) return json({ error: 'Workspace not found or forbidden' }, 404)

    const [settingsResult, threadsResult, reposResult] = await Promise.all([
      caller.from('workspace_settings').select('*').eq('workspace_id', workspaceId).maybeSingle(),
      caller.from('threads').select('id, mode, status').eq('workspace_id', workspaceId),
      caller.from('github_repositories').select('full_name').eq('workspace_id', workspaceId).order('created_at'),
    ])

    const settings = settingsResult.data
    const threads = threadsResult.data ?? []
    const repos = reposResult.data ?? []
    const threadIds = threads.map((row: any) => row.id)
    const db = serviceClient()

    let councilRunCount = 0
    let agentRunCount = 0
    let latestGithubEvent: any = null
    if (threadIds.length) {
      const [runsResult, agentsResult] = await Promise.all([
        db.from('council_runs').select('id', { count: 'exact', head: true }).in('thread_id', threadIds),
        db.from('agent_runs').select('id', { count: 'exact', head: true }).in('thread_id', threadIds),
      ])
      councilRunCount = runsResult.count ?? 0
      agentRunCount = agentsResult.count ?? 0
    }

    const { data: githubEvents } = await db.from('github_events')
      .select('event_name, repository_full_name, received_at')
      .eq('workspace_id', workspaceId)
      .order('received_at', { ascending: false })
      .limit(1)
    latestGithubEvent = githubEvents?.[0] ?? null

    return json({
      ok: true,
      workspace: { id: workspace.id, name: workspace.name },
      auth: { rls_access: true },
      database: {
        threads: threads.length,
        council_threads: threads.filter((row: any) => row.mode !== 'board').length,
        board_threads: threads.filter((row: any) => row.mode === 'board').length,
        council_runs: councilRunCount,
        agent_runs: agentRunCount,
      },
      providers: {
        openai: { enabled: Boolean(settings?.enable_openai), configured: Boolean(Deno.env.get('OPENAI_API_KEY')), model: settings?.openai_model ?? 'gpt-6.1-sol' },
        anthropic: { enabled: Boolean(settings?.enable_anthropic), configured: Boolean(Deno.env.get('ANTHROPIC_API_KEY')), model: settings?.anthropic_model ?? 'claude-sonnet-5-5' },
        xai: { enabled: Boolean(settings?.enable_xai), configured: Boolean(Deno.env.get('XAI_API_KEY')), model: settings?.xai_model ?? 'grok-4.7' },
      },
      github: {
        webhook_secret_configured: Boolean(Deno.env.get('GITHUB_WEBHOOK_SECRET')),
        repositories: repos.map((row: any) => row.full_name),
        latest_event: latestGithubEvent,
      },
      checked_at: new Date().toISOString(),
    })
  }
  const threadId = body?.thread_id
  if (!threadId) return json({ error: 'thread_id is required' }, 400)

  const { data: thread, error: threadError } = await caller
    .from('threads')
    .select('id, workspace_id, title, objective, status, mode')
    .eq('id', threadId)
    .single()
  if (threadError || !thread) return json({ error: 'Thread not found or forbidden' }, 404)

  // Board threads use board-reply; structured deliberation is council-only.
  if (thread.mode === 'board') {
    return json({
      error: "Thread is in board mode (use board-reply for continuous chat)",
    }, 409)
  }

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
    anthropic_model: 'claude-sonnet-5-5',
    xai_model: 'grok-4.7',
    openai_economy_model: 'gpt-6-luna',
    max_context_contributions: 18,
    max_context_chars: 18000,
    provider_timeout_ms: 30000,
    max_retries: 0,
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
      const { data: sameRun } = await db.from('council_runs')
        .select('*')
        .eq('thread_id', thread.id)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle()

      if (sameRun) {
        const status = sameRun.status === 'queued' || sameRun.status === 'running' ? 202 : 200
        return json({ ok: sameRun.status !== 'failed', reused: true, run: sameRun }, status)
      }

      const { data: activeRun } = await db.from('council_runs')
        .select('*')
        .eq('thread_id', thread.id)
        .in('status', ['queued', 'running'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (activeRun) return json({ ok: true, reused: true, run: activeRun }, 202)
    }
    return json({ error: createRunError.message }, 500)
  }

  const runId = councilRun.id

  try {
    const limit = Number(settings.max_context_contributions ?? 18)
    const maxContextChars = Number(settings.max_context_chars ?? 18000)
    const { data: existingRows } = await db.from('contributions')
      .select('agent, provider, model, kind, round, summary, assumptions, evidence, recommendations, disagreements, confidence')
      .eq('thread_id', thread.id)
      .order('created_at', { ascending: false })
      .limit(limit)

    const [{ data: refs }, { data: memories }, { data: tasks }, { data: evidenceRefs }] = await Promise.all([
      db.from('github_refs')
        .select('repository_full_name, ref_type, ref_number, sha, path, url, metadata')
        .eq('workspace_id', thread.workspace_id)
        .order('created_at', { ascending: false })
        .limit(30),
      db.from('memory_items')
        .select('kind, title, content, confidence, thread_id, updated_at')
        .eq('workspace_id', thread.workspace_id)
        .eq('status', 'active')
        .order('updated_at', { ascending: false })
        .limit(24),
      db.from('tasks')
        .select('title, description, status, priority, owner_type, owner, due_at, github_url')
        .eq('workspace_id', thread.workspace_id)
        .in('status', ['todo', 'in_progress', 'blocked'])
        .order('priority', { ascending: true })
        .order('updated_at', { ascending: false })
        .limit(20),
      db.from('evidence_refs')
        .select('source_type, title, url, repository_full_name, sha, path, excerpt')
        .eq('workspace_id', thread.workspace_id)
        .order('created_at', { ascending: false })
        .limit(24),
    ])

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

    const baseExisting = compactContributions([...(existingRows ?? [])].reverse() as SharedContribution[], maxContextChars)
    const githubContext = compactGithubContext(refs ?? [])
    const memoryContext = compactMemoryContext(memories ?? [])
    const taskContext = compactTaskContext(tasks ?? [])
    const evidenceContext = compactEvidenceContext(evidenceRefs ?? [])
    const proposals = await runPhase(db, runId, thread, 'proposal', 1, proposalAdapters, baseExisting, githubContext, memoryContext, taskContext, evidenceContext, strategy)
    if (!proposals.length) throw new Error('All configured providers failed during proposal phase')

    await db.from('council_runs').update({ current_phase: 'critique' }).eq('id', runId)
    await db.from('threads').update({ current_round: 2 }).eq('id', thread.id)

    const critiqueContext = compactContributions([...baseExisting, ...proposals] as SharedContribution[], maxContextChars)
    const critiques = await runPhase(
      db,
      runId,
      thread,
      'critique',
      2,
      buildAdapters(settings, 'critique', strategy),
      critiqueContext,
      githubContext,
      memoryContext,
      taskContext,
      evidenceContext,
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

    const synthesisContext = compactContributions([...critiqueContext, ...critiques] as SharedContribution[], maxContextChars)
    const synthesis = await runPhase(
      db,
      runId,
      thread,
      'synthesis',
      3,
      [synthesisAdapter],
      synthesisContext,
      githubContext,
      memoryContext,
      taskContext,
      evidenceContext,
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
