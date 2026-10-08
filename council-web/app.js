import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.1'

const $ = (id) => document.getElementById(id)
const state = {
  client: null,
  user: null,
  workspaces: [],
  workspaceId: null,
  threads: [],
  threadId: null,
  currentThread: null,
  channels: [],
  settings: null,
  health: null,
  decision: null,
  refreshTimer: null,
}

function config() {
  try {
    return JSON.parse(localStorage.getItem('council.supabase') || 'null') || window.COUNCIL_CONFIG || null
  } catch {
    return window.COUNCIL_CONFIG || null
  }
}

function saveConfig(url, key) {
  localStorage.setItem('council.supabase', JSON.stringify({ url, key }))
}

function clearChannels() {
  state.channels.forEach((channel) => state.client?.removeChannel(channel))
  state.channels = []
}

function setConnection(text) {
  $('connectionBadge').textContent = text
}

function showOnly(id) {
  ['setupPanel', 'authPanel', 'appPanel'].forEach((panel) => $(panel).classList.toggle('hidden', panel !== id))
}

function esc(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[char]))
}

function fmtTime(value) {
  return value ? new Date(value).toLocaleString() : '—'
}

function threadMode(thread = state.currentThread) {
  return thread?.mode === 'board' ? 'board' : 'council'
}

async function boot() {
  const connection = config()
  if (!connection?.url || !connection?.key) {
    showOnly('setupPanel')
    setConnection('Not configured')
    return
  }

  $('supabaseUrl').value = connection.url
  $('supabaseKey').value = connection.key
  state.client = createClient(connection.url, connection.key)

  const { data } = await state.client.auth.getSession()
  state.user = data.session?.user ?? null

  if (!state.user) {
    showOnly('authPanel')
    setConnection('Connected')
    return
  }

  $('signOutButton').classList.remove('hidden')
  showOnly('appPanel')
  setConnection(state.user.email ?? 'Signed in')
  await Promise.all([loadHealth(), loadWorkspaces()])
}

async function loadHealth() {
  const { data, error } = await state.client.functions.invoke('council-orchestrator', {
    body: { action: 'health' },
  })

  state.health = error ? null : data
  if (error) {
    $('providerHealth').innerHTML = '<span class="provider-dot missing">health unavailable</span>'
    return
  }

  const items = [
    ['ChatGPT', data.providers?.openai?.configured],
    ['Claude', data.providers?.anthropic?.configured],
    ['Grok', data.providers?.xai?.configured],
    ['GitHub', data.github_webhook?.configured],
  ]

  $('providerHealth').innerHTML = items.map(([name, ready]) =>
    `<span class="provider-dot ${ready ? 'ok' : 'missing'}">${name}: ${ready ? 'ready' : 'missing key'}</span>`
  ).join('')
}

async function loadWorkspaces() {
  const { data, error } = await state.client.from('workspaces').select('*').order('created_at')
  if (error) return alert(error.message)

  state.workspaces = data ?? []
  if (!state.workspaceId && state.workspaces.length) state.workspaceId = state.workspaces[0].id
  renderWorkspaces()
  await loadWorkspaceSettings()
  await loadThreads()
}

function renderWorkspaces() {
  $('workspaceList').innerHTML = state.workspaces.map((workspace) =>
    `<button class="list-item ${workspace.id === state.workspaceId ? 'active' : ''}" data-workspace="${workspace.id}">${esc(workspace.name)}</button>`
  ).join('') || '<div class="subtle">No workspaces yet.</div>'

  document.querySelectorAll('[data-workspace]').forEach((element) => {
    element.addEventListener('click', async () => {
      state.workspaceId = element.dataset.workspace
      state.threadId = null
      state.currentThread = null
      state.decision = null
      renderWorkspaces()
      await loadWorkspaceSettings()
      await loadThreads()
    })
  })

  $('newThreadButton').disabled = !state.workspaceId
  $('workspaceSettingsButton').disabled = !state.workspaceId
  $('knowledgeButton').disabled = !state.workspaceId
  $('diagnosticsButton').disabled = !state.workspaceId
}

async function loadWorkspaceSettings() {
  state.settings = null
  if (!state.workspaceId) return

  const { data } = await state.client
    .from('workspace_settings')
    .select('*')
    .eq('workspace_id', state.workspaceId)
    .maybeSingle()

  state.settings = data
  if (data) $('strategySelect').value = data.strategy
}

async function loadThreads() {
  if (!state.workspaceId) {
    state.threads = []
    renderThreads()
    return
  }

  const { data, error } = await state.client
    .from('threads')
    .select('*')
    .eq('workspace_id', state.workspaceId)
    .order('updated_at', { ascending: false })

  if (error) return alert(error.message)

  state.threads = data ?? []
  if (state.threadId && !state.threads.some((thread) => thread.id === state.threadId)) {
    state.threadId = null
    state.currentThread = null
  }

  renderThreads()

  if (state.threadId) {
    await openThread(state.threadId)
  } else {
    $('emptyState').classList.remove('hidden')
    $('threadView').classList.add('hidden')
  }
}

function renderThreads() {
  $('threadList').innerHTML = state.threads.map((thread) =>
    `<button class="list-item ${thread.id === state.threadId ? 'active' : ''}" data-thread="${thread.id}">
      ${esc(thread.title)}
      <br><span class="subtle">${esc(thread.mode || 'council')} · ${esc(thread.status)}</span>
    </button>`
  ).join('') || '<div class="subtle">No threads yet.</div>'

  document.querySelectorAll('[data-thread]').forEach((element) => {
    element.addEventListener('click', () => openThread(element.dataset.thread))
  })
}

function renderMode(thread) {
  const mode = threadMode(thread)
  $('threadMode').textContent = mode === 'board' ? 'Board' : 'Council'
  $('threadRound').classList.toggle('hidden', mode === 'board')
  $('councilControls').classList.toggle('hidden', mode === 'board')
  $('boardControls').classList.toggle('hidden', mode !== 'board')
  $('boardComposer').classList.toggle('hidden', mode !== 'board')
  $('councilRunSection').classList.toggle('hidden', mode === 'board')
  $('decisionSection').classList.toggle('hidden', mode === 'board')
  $('timelineHeading').textContent = mode === 'board' ? 'Shared board' : 'Live deliberation'
}

async function openThread(id) {
  state.threadId = id
  state.currentThread = state.threads.find((thread) => thread.id === id) ?? null
  renderThreads()

  if (!state.currentThread) return

  $('emptyState').classList.add('hidden')
  $('threadView').classList.remove('hidden')
  $('threadTitle').textContent = state.currentThread.title
  $('threadObjective').textContent = state.currentThread.objective
  $('strategySelect').value = state.settings?.strategy ?? 'balanced'
  renderMode(state.currentThread)

  await refreshThreadData()
  subscribeThread()
}

async function refreshThreadData() {
  if (!state.threadId) return

  const isCouncil = threadMode() === 'council'
  const empty = Promise.resolve({ data: [] })
  const [
    { data: contributionsDesc },
    { data: decisions },
    { data: thread },
    { data: runs },
    { data: agentRuns },
  ] = await Promise.all([
    state.client.from('contributions').select('*').eq('thread_id', state.threadId).order('created_at', { ascending: false }).limit(200),
    isCouncil ? state.client.from('decisions').select('*').eq('thread_id', state.threadId).order('created_at', { ascending: false }).limit(1) : empty,
    state.client.from('threads').select('*').eq('id', state.threadId).single(),
    isCouncil ? state.client.from('council_runs').select('*').eq('thread_id', state.threadId).order('created_at', { ascending: false }).limit(10) : empty,
    state.client.from('agent_runs').select('*').eq('thread_id', state.threadId).order('created_at', { ascending: false }).limit(30),
  ])
  const contributions = [...(contributionsDesc ?? [])].reverse()

  if (thread) {
    state.currentThread = thread
    const index = state.threads.findIndex((item) => item.id === thread.id)
    if (index >= 0) state.threads[index] = thread
    $('threadStatus').textContent = thread.status
    $('threadRound').textContent = `Round ${thread.current_round}`
    renderMode(thread)
    renderThreads()
  }

  renderRuns(runs ?? [])
  renderAgentRuns(agentRuns ?? [])
  renderContributions(contributions ?? [])

  state.decision = decisions?.[0] ?? null
  renderDecision(state.decision)

  const councilActive = (runs ?? []).some((run) => ['queued', 'running'].includes(run.status))
  const boardActive = (agentRuns ?? []).some((run) => run.phase === 'message' && run.status === 'running')
  $('runCouncilButton').disabled = councilActive
  $('nextAIButton').disabled = boardActive
}

function renderRuns(rows) {
  $('runCount').textContent = `${rows.length} recent`
  $('runHistory').innerHTML = rows.map((run) =>
    `<div class="run-row">
      <div><strong>${esc(run.strategy)}</strong><br><span class="subtle">${fmtTime(run.created_at)}</span></div>
      <div>${esc(run.current_phase || '—')}${run.error ? `<div class="error">${esc(run.error)}</div>` : ''}</div>
      <span class="badge">${esc(run.status)}</span>
    </div>`
  ).join('') || '<div class="subtle">No Council runs yet.</div>'
}

function renderAgentRuns(rows) {
  $('agentRuns').innerHTML = rows.map((run) =>
    `<div class="run-row">
      <div><strong>${esc(run.provider)}</strong><br><span class="subtle">${esc(run.model || '')}</span></div>
      <div>${esc(run.phase)}${run.error ? `<div class="error">${esc(run.error)}</div>` : ''}</div>
      <span class="badge">${esc(run.status)}</span>
    </div>`
  ).join('') || '<div class="subtle">No provider calls yet.</div>'
}

function renderContributions(rows) {
  $('contributionCount').textContent = `${rows.length} published`
  $('contributions').innerHTML = rows.map((contribution) => {
    const groups = [
      ['Assumptions', contribution.assumptions],
      ['Evidence', contribution.evidence],
      ['Recommendations', contribution.recommendations],
      ['Disagreements', contribution.disagreements],
    ].filter(([, items]) => Array.isArray(items) && items.length)

    const label = contribution.kind === 'message'
      ? esc(contribution.agent === 'human' ? 'You' : contribution.agent)
      : `${esc(contribution.agent)} · ${esc(contribution.kind)} · round ${contribution.round}`

    return `<article class="card" data-kind="${esc(contribution.kind)}" data-agent="${esc(contribution.agent)}">
      <div class="card-head">
        <h3>${label}</h3>
        <span class="subtle">${esc(contribution.model || contribution.provider || '')}${contribution.confidence == null ? '' : ` · ${Math.round(Number(contribution.confidence) * 100)}%`}</span>
      </div>
      <p>${esc(contribution.summary)}</p>
      ${groups.map(([name, items]) => `<strong>${name}</strong><ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`).join('')}
    </article>`
  }).join('') || '<div class="subtle">No contributions yet.</div>'
}

function renderDecision(decision) {
  $('decision').textContent = decision
    ? `${decision.decision}${decision.rationale ? `\n\n${decision.rationale}` : ''}`
    : 'No synthesis yet.'

  $('decision').classList.toggle('muted', !decision)
  $('decisionStatus').classList.toggle('hidden', !decision)
  $('decisionStatus').textContent = decision?.status ?? ''
  $('decisionActions').classList.toggle('hidden', !decision || decision.status !== 'proposed')
}

function scheduleThreadRefresh() {
  if (state.refreshTimer) clearTimeout(state.refreshTimer)
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null
    refreshThreadData()
  }, 120)
}

function subscribeThread() {
  clearChannels()
  if (!state.threadId) return

  const refresh = () => scheduleThreadRefresh()
  const channel = state.client.channel(`council-thread-${state.threadId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'contributions', filter: `thread_id=eq.${state.threadId}` }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'decisions', filter: `thread_id=eq.${state.threadId}` }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'threads', filter: `id=eq.${state.threadId}` }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_runs', filter: `thread_id=eq.${state.threadId}` }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'council_runs', filter: `thread_id=eq.${state.threadId}` }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'memory_items', filter: `workspace_id=eq.${state.workspaceId}` }, () => { if ($('knowledgeDialog').open) loadKnowledge() })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `workspace_id=eq.${state.workspaceId}` }, () => { if ($('knowledgeDialog').open) loadKnowledge() })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'evidence_refs', filter: `workspace_id=eq.${state.workspaceId}` }, () => { if ($('knowledgeDialog').open) loadKnowledge() })
    .subscribe()

  state.channels.push(channel)
}

async function reviewDecision(status) {
  if (!state.decision) return

  const { error } = await state.client.from('decisions').update({ status }).eq('id', state.decision.id)
  if (error) return alert(error.message)

  $('runMessage').textContent = status === 'accepted'
    ? 'Decision accepted.'
    : 'Decision rejected; thread reopened.'

  await refreshThreadData()
}

async function requestBoardReply() {
  if (!state.threadId || threadMode() !== 'board') return

  $('nextAIButton').disabled = true
  $('runMessage').textContent = 'Asking the next AI…'

  const provider = $('boardProviderSelect').value
  const body = {
    thread_id: state.threadId,
    idempotency_key: crypto.randomUUID(),
    ...(provider ? { provider } : {}),
  }

  const { data, error } = await state.client.functions.invoke('board-reply', { body })
  $('nextAIButton').disabled = false

  $('runMessage').textContent = error
    ? `Board reply failed: ${error.message}`
    : data.reused
      ? 'Existing board request reused.'
      : `${data.agent || 'AI'} replied.`

  await refreshThreadData()
}

async function sendBoardMessage() {
  if (!state.threadId || threadMode() !== 'board') return

  const message = $('boardMessage').value.trim()
  if (!message) return

  $('sendBoardMessageButton').disabled = true
  const { error } = await state.client.from('contributions').insert({
    thread_id: state.threadId,
    agent: 'human',
    kind: 'message',
    round: 0,
    summary: message,
    created_by: state.user.id,
  })
  $('sendBoardMessageButton').disabled = false

  if (error) {
    $('runMessage').textContent = `Message failed: ${error.message}`
    return
  }

  $('boardMessage').value = ''
  $('runMessage').textContent = 'Message added to the shared board.'
  await refreshThreadData()
}

$('saveConnection').addEventListener('click', () => {
  saveConfig($('supabaseUrl').value.trim(), $('supabaseKey').value.trim())
  location.reload()
})

$('connectionSettingsButton').addEventListener('click', () => showOnly('setupPanel'))

$('signInButton').addEventListener('click', async () => {
  const email = $('email').value.trim()
  if (!email) return

  const { error } = await state.client.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.href.split('#')[0] },
  })

  $('authMessage').textContent = error ? error.message : 'Magic link sent. Open it in this browser.'
})

$('signOutButton').addEventListener('click', async () => {
  await state.client.auth.signOut()
  clearChannels()
  location.reload()
})

document.querySelectorAll('[data-close]').forEach((element) => {
  element.addEventListener('click', () => $(element.dataset.close).close())
})

$('newWorkspaceButton').addEventListener('click', () => $('workspaceDialog').showModal())

$('workspaceForm').addEventListener('submit', async (event) => {
  event.preventDefault()
  const name = $('workspaceName').value.trim()
  if (!name) return

  const { data: { user } } = await state.client.auth.getUser()
  const { data, error } = await state.client
    .from('workspaces')
    .insert({ name, owner_id: user.id })
    .select('*')
    .single()

  if (error) return alert(error.message)

  $('workspaceDialog').close()
  $('workspaceName').value = ''
  state.workspaceId = data.id
  await loadWorkspaces()
})

$('newThreadButton').addEventListener('click', () => $('threadDialog').showModal())

$('threadForm').addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!state.workspaceId) return

  const { data: { user } } = await state.client.auth.getUser()
  const payload = {
    workspace_id: state.workspaceId,
    created_by: user.id,
    mode: $('newThreadMode').value,
    title: $('newThreadTitle').value.trim(),
    objective: $('newThreadObjective').value.trim(),
  }

  const { data, error } = await state.client.from('threads').insert(payload).select('*').single()
  if (error) return alert(error.message)

  $('threadDialog').close()
  $('newThreadTitle').value = ''
  $('newThreadObjective').value = ''
  $('newThreadMode').value = 'council'
  state.threadId = data.id
  await loadThreads()
  await openThread(data.id)
})

async function loadKnowledge() {
  if (!state.workspaceId) return

  const [{ data: memories, error: memoryError }, { data: tasks, error: taskError }, { data: evidence, error: evidenceError }] = await Promise.all([
    state.client.from('memory_items').select('*').eq('workspace_id', state.workspaceId).eq('status', 'active').order('updated_at', { ascending:false }).limit(40),
    state.client.from('tasks').select('*').eq('workspace_id', state.workspaceId).not('status', 'in', '(done,cancelled)').order('priority').order('updated_at', { ascending:false }).limit(40),
    state.client.from('evidence_refs').select('*').eq('workspace_id', state.workspaceId).order('created_at', { ascending:false }).limit(40),
  ])

  if (memoryError || taskError || evidenceError) {
    const message = memoryError?.message || taskError?.message || evidenceError?.message || 'Unknown error'
    $('memoryList').innerHTML = `<div class="subtle">${esc(message)}</div>`
    $('taskList').innerHTML = ''
    $('evidenceList').innerHTML = ''
    return
  }

  $('memoryList').innerHTML = (memories ?? []).map((item) =>
    `<article class="knowledge-item"><div class="knowledge-head"><strong>${esc(item.title)}</strong><span class="badge">${esc(item.kind)}</span></div><p>${esc(item.content)}</p><div class="knowledge-actions"><span class="subtle">${item.thread_id ? 'thread-linked' : 'workspace-wide'}</span><button class="secondary small" data-memory-archive="${item.id}">Archive</button></div></article>`
  ).join('') || '<div class="subtle">No active memory yet.</div>'

  $('taskList').innerHTML = (tasks ?? []).map((task) =>
    `<article class="knowledge-item"><div class="knowledge-head"><strong>${esc(task.title)}</strong><span class="badge">P${task.priority} · ${esc(task.status)}</span></div><p>${esc(task.description || '')}</p><div class="knowledge-actions"><span class="subtle">${esc(task.owner || task.owner_type || 'unassigned')}</span><div class="row"><button class="secondary small" data-task-status="in_progress" data-task-id="${task.id}">Start</button><button class="secondary small" data-task-status="blocked" data-task-id="${task.id}">Block</button><button class="small" data-task-status="done" data-task-id="${task.id}">Done</button></div></div></article>`
  ).join('') || '<div class="subtle">No open tasks.</div>'

  $('evidenceList').innerHTML = (evidence ?? []).map((item) => {
    const source = item.url || (item.repository_full_name ? `${item.repository_full_name}${item.sha ? `@${item.sha}` : ''}` : item.source_type)
    return `<article class="knowledge-item"><div class="knowledge-head"><strong>${esc(item.title || 'Evidence')}</strong><span class="badge">${esc(item.source_type)}</span></div><p>${esc(item.excerpt || source || '')}</p><span class="subtle">${esc(source || '')}</span></article>`
  }).join('') || '<div class="subtle">No evidence references yet.</div>'

  document.querySelectorAll('[data-memory-archive]').forEach((button) => button.addEventListener('click', async () => {
    const { error } = await state.client.from('memory_items').update({ status:'archived' }).eq('id', button.dataset.memoryArchive)
    if (error) return alert(error.message)
    await loadKnowledge()
  }))

  document.querySelectorAll('[data-task-status]').forEach((button) => button.addEventListener('click', async () => {
    const status = button.dataset.taskStatus
    const patch = { status, ...(status === 'done' ? { completed_at:new Date().toISOString() } : { completed_at:null }) }
    const { error } = await state.client.from('tasks').update(patch).eq('id', button.dataset.taskId)
    if (error) return alert(error.message)
    await loadKnowledge()
  }))
}

$('knowledgeButton').addEventListener('click', async () => {
  if (!state.workspaceId) return
  $('knowledgeDialog').showModal()
  await loadKnowledge()
})

$('addMemoryButton').addEventListener('click', () => {
  $('memoryCurrentThread').checked = Boolean(state.threadId)
  $('memoryDialog').showModal()
})

$('addTaskButton').addEventListener('click', () => {
  $('taskCurrentThread').checked = Boolean(state.threadId)
  $('taskDialog').showModal()
})

$('addEvidenceButton').addEventListener('click', () => {
  $('evidenceCurrentThread').checked = Boolean(state.threadId)
  $('evidenceDialog').showModal()
})

$('memoryForm').addEventListener('submit', async (event) => {
  event.preventDefault()
  const payload = {
    workspace_id: state.workspaceId,
    thread_id: $('memoryCurrentThread').checked ? state.threadId : null,
    kind: $('memoryKind').value,
    title: $('memoryTitle').value.trim(),
    content: $('memoryContent').value.trim(),
    created_by: state.user.id,
  }
  const { error } = await state.client.from('memory_items').insert(payload)
  if (error) return alert(error.message)
  $('memoryForm').reset()
  $('memoryDialog').close()
  await loadKnowledge()
})

$('taskForm').addEventListener('submit', async (event) => {
  event.preventDefault()
  const dueValue = $('taskDueAt').value
  const payload = {
    workspace_id: state.workspaceId,
    thread_id: $('taskCurrentThread').checked ? state.threadId : null,
    title: $('taskTitle').value.trim(),
    description: $('taskDescription').value.trim(),
    priority: Number($('taskPriority').value),
    owner_type: $('taskOwnerType').value,
    owner: $('taskOwner').value.trim() || null,
    due_at: dueValue ? new Date(dueValue).toISOString() : null,
    created_by: state.user.id,
  }
  const { error } = await state.client.from('tasks').insert(payload)
  if (error) return alert(error.message)
  $('taskForm').reset()
  $('taskDialog').close()
  await loadKnowledge()
})

$('evidenceForm').addEventListener('submit', async (event) => {
  event.preventDefault()
  const payload = {
    workspace_id: state.workspaceId,
    thread_id: $('evidenceCurrentThread').checked ? state.threadId : null,
    source_type: $('evidenceSourceType').value,
    title: $('evidenceTitle').value.trim() || null,
    url: $('evidenceUrl').value.trim() || null,
    repository_full_name: $('evidenceRepo').value.trim() || null,
    sha: $('evidenceSha').value.trim() || null,
    path: $('evidencePath').value.trim() || null,
    excerpt: $('evidenceExcerpt').value.trim() || null,
    created_by: state.user.id,
  }
  const { error } = await state.client.from('evidence_refs').insert(payload)
  if (error) return alert(error.message)
  $('evidenceForm').reset()
  $('evidenceDialog').close()
  await loadKnowledge()
})

$('diagnosticsButton').addEventListener('click', () => {
  if (!state.workspaceId) return
  $('diagnosticsSummary').innerHTML = '<div class="subtle">Run checks to inspect this workspace.</div>'
  $('diagnosticsRaw').classList.add('hidden')
  $('diagnosticsDialog').showModal()
})

$('runDiagnosticsButton').addEventListener('click', async () => {
  if (!state.workspaceId) return
  $('runDiagnosticsButton').disabled = true
  $('diagnosticsSummary').innerHTML = '<div class="subtle">Checking production…</div>'

  const { data, error } = await state.client.functions.invoke('council-orchestrator', {
    body: { action: 'diagnostics', workspace_id: state.workspaceId },
  })

  $('runDiagnosticsButton').disabled = false

  if (error || !data) {
    $('diagnosticsSummary').innerHTML = `<div class="diagnostic-item bad"><strong>Diagnostics failed</strong><span>${esc(error?.message || 'Unknown error')}</span></div>`
    return
  }

  const providerRows = Object.entries(data.providers || {}).map(([name, provider]) => ({
    label: name === 'openai' ? 'ChatGPT' : name === 'anthropic' ? 'Claude' : 'Grok',
    ok: Boolean(provider.enabled && provider.configured),
    detail: !provider.enabled ? 'disabled' : provider.configured ? provider.model : 'API key missing',
  }))

  const cards = [
    { label: 'Authenticated RLS', ok: Boolean(data.auth?.rls_access), detail: data.auth?.rls_access ? 'workspace accessible' : 'failed' },
    ...providerRows,
    { label: 'GitHub webhook secret', ok: Boolean(data.github?.webhook_secret_configured), detail: data.github?.webhook_secret_configured ? 'configured' : 'missing' },
    { label: 'Mapped repositories', ok: (data.github?.repositories?.length ?? 0) > 0, detail: `${data.github?.repositories?.length ?? 0} mapped` },
    { label: 'GitHub events received', ok: Boolean(data.github?.latest_event), detail: data.github?.latest_event ? `${data.github.latest_event.event_name} · ${data.github.latest_event.repository_full_name}` : 'none yet' },
    { label: 'Council activity', ok: (data.database?.council_runs ?? 0) > 0, detail: `${data.database?.council_runs ?? 0} runs` },
    { label: 'Provider activity', ok: (data.database?.agent_runs ?? 0) > 0, detail: `${data.database?.agent_runs ?? 0} provider runs` },
    { label: 'Memory', ok: (data.database?.memory_items ?? 0) > 0, detail: `${data.database?.memory_items ?? 0} active items` },
    { label: 'Open tasks', ok: (data.database?.open_tasks ?? 0) > 0, detail: `${data.database?.open_tasks ?? 0} open` },
    { label: 'Evidence', ok: (data.database?.evidence_refs ?? 0) > 0, detail: `${data.database?.evidence_refs ?? 0} refs` },
  ]

  $('diagnosticsSummary').innerHTML = cards.map((card) =>
    `<div class="diagnostic-item ${card.ok ? 'good' : 'warn'}"><strong>${esc(card.label)}</strong><span>${esc(card.detail)}</span></div>`
  ).join('')

  $('diagnosticsRaw').textContent = JSON.stringify(data, null, 2)
  $('diagnosticsRaw').classList.remove('hidden')
})

$('workspaceSettingsButton').addEventListener('click', async () => {
  await loadWorkspaceSettings()
  const settings = state.settings
  if (!settings) return

  $('settingsStrategy').value = settings.strategy
  $('enableOpenAI').checked = settings.enable_openai
  $('enableAnthropic').checked = settings.enable_anthropic
  $('enableXAI').checked = settings.enable_xai
  $('requireApproval').checked = settings.require_human_approval
  $('openAIModel').value = settings.openai_model
  $('openAISynthesisModel').value = settings.openai_synthesis_model
  $('openAIEconomyModel').value = settings.openai_economy_model ?? 'gpt-6-luna'
  $('anthropicModel').value = settings.anthropic_model
  $('xaiModel').value = settings.xai_model
  $('maxContextContributions').value = settings.max_context_contributions ?? 18
  $('maxContextChars').value = settings.max_context_chars ?? 18000
  $('providerTimeout').value = settings.provider_timeout_ms
  $('maxRetries').value = settings.max_retries
  $('boardStaleSeconds').value = settings.board_stale_after_seconds ?? 300
  $('settingsDialog').showModal()
})

$('settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!state.workspaceId) return

  const patch = {
    strategy: $('settingsStrategy').value,
    enable_openai: $('enableOpenAI').checked,
    enable_anthropic: $('enableAnthropic').checked,
    enable_xai: $('enableXAI').checked,
    require_human_approval: $('requireApproval').checked,
    openai_model: $('openAIModel').value.trim(),
    openai_synthesis_model: $('openAISynthesisModel').value.trim(),
    openai_economy_model: $('openAIEconomyModel').value.trim(),
    anthropic_model: $('anthropicModel').value.trim(),
    xai_model: $('xaiModel').value.trim(),
    max_context_contributions: Number($('maxContextContributions').value),
    max_context_chars: Number($('maxContextChars').value),
    provider_timeout_ms: Number($('providerTimeout').value),
    max_retries: Number($('maxRetries').value),
    board_stale_after_seconds: Number($('boardStaleSeconds').value),
  }

  const { data, error } = await state.client
    .from('workspace_settings')
    .update(patch)
    .eq('workspace_id', state.workspaceId)
    .select('*')
    .single()

  if (error) return alert(error.message)

  state.settings = data
  $('strategySelect').value = data.strategy
  $('settingsDialog').close()
})

$('runCouncilButton').addEventListener('click', async () => {
  if (!state.threadId || threadMode() !== 'council') return

  const noModelKeys = state.health && !Object.values(state.health.providers || {}).some((provider) => provider.configured)
  if (noModelKeys) {
    $('runMessage').textContent = 'No model API keys are configured yet.'
    return
  }

  $('runCouncilButton').disabled = true
  $('runMessage').textContent = 'Council is deliberating…'

  const { data, error } = await state.client.functions.invoke('council-orchestrator', {
    body: {
      thread_id: state.threadId,
      strategy: $('strategySelect').value,
      idempotency_key: crypto.randomUUID(),
    },
  })

  $('runCouncilButton').disabled = false
  $('runMessage').textContent = error
    ? `Run failed: ${error.message}`
    : data.reused
      ? 'An existing active run was reused.'
      : data.awaiting_approval
        ? `Synthesis ready for approval · ${data.proposals} proposals · ${data.critiques} critiques`
        : `Completed · ${data.proposals} proposals · ${data.critiques} critiques`

  await refreshThreadData()
})

$('nextAIButton').addEventListener('click', requestBoardReply)
$('sendBoardMessageButton').addEventListener('click', sendBoardMessage)

$('boardMessage').addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    sendBoardMessage()
  }
})

$('acceptDecisionButton').addEventListener('click', () => reviewDecision('accepted'))
$('rejectDecisionButton').addEventListener('click', () => reviewDecision('rejected'))

$('mapRepoButton').addEventListener('click', async () => {
  const fullName = $('repoFullName').value.trim()
  if (!fullName || !state.workspaceId) return

  const { data: { user } } = await state.client.auth.getUser()
  const { error } = await state.client.from('github_repositories').insert({
    workspace_id: state.workspaceId,
    full_name: fullName,
    created_by: user.id,
  })

  $('repoMessage').textContent = error
    ? error.message
    : `Mapped ${fullName}. GitHub events will attach after its signed webhook is configured.`
})

window.addEventListener('hashchange', () => setTimeout(boot, 50))
boot()
