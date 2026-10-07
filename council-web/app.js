import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.1'

const $ = (id) => document.getElementById(id)
const state = {
  client: null, user: null, workspaces: [], workspaceId: null,
  threads: [], threadId: null, channels: [], settings: null, health: null, decision: null,
}

function config() {
  try {
    return JSON.parse(localStorage.getItem('council.supabase') || 'null') || window.COUNCIL_CONFIG || null
  } catch {
    return window.COUNCIL_CONFIG || null
  }
}
function saveConfig(url, key) { localStorage.setItem('council.supabase', JSON.stringify({ url, key })) }
function clearChannels() { state.channels.forEach((c) => state.client?.removeChannel(c)); state.channels = [] }
function setConnection(text) { $('connectionBadge').textContent = text }
function showOnly(id) { ['setupPanel','authPanel','appPanel'].forEach((x) => $(x).classList.toggle('hidden', x !== id)) }
function esc(value='') { return String(value).replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])) }
function fmtTime(value) { return value ? new Date(value).toLocaleString() : '—' }

async function boot() {
  const c = config()
  if (!c?.url || !c?.key) { showOnly('setupPanel'); setConnection('Not configured'); return }
  $('supabaseUrl').value = c.url; $('supabaseKey').value = c.key
  state.client = createClient(c.url, c.key)
  const { data } = await state.client.auth.getSession()
  state.user = data.session?.user ?? null
  if (!state.user) { showOnly('authPanel'); setConnection('Connected'); return }

  $('signOutButton').classList.remove('hidden')
  showOnly('appPanel'); setConnection(state.user.email ?? 'Signed in')
  await Promise.all([loadHealth(), loadWorkspaces()])
}

async function loadHealth() {
  const { data, error } = await state.client.functions.invoke('council-orchestrator', { body: { action: 'health' } })
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
  $('providerHealth').innerHTML = items.map(([name, ok]) =>
    `<span class="provider-dot ${ok ? 'ok' : 'missing'}">${name}: ${ok ? 'ready' : 'missing key'}</span>`
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
  $('workspaceList').innerHTML = state.workspaces.map((w) =>
    `<button class="list-item ${w.id===state.workspaceId?'active':''}" data-workspace="${w.id}">${esc(w.name)}</button>`
  ).join('') || '<div class="subtle">No workspaces yet.</div>'
  document.querySelectorAll('[data-workspace]').forEach((el) => el.addEventListener('click', async () => {
    state.workspaceId = el.dataset.workspace; state.threadId = null; state.decision = null
    renderWorkspaces(); await loadWorkspaceSettings(); await loadThreads()
  }))
  $('newThreadButton').disabled = !state.workspaceId
  $('workspaceSettingsButton').disabled = !state.workspaceId
}

async function loadWorkspaceSettings() {
  state.settings = null
  if (!state.workspaceId) return
  const { data } = await state.client.from('workspace_settings').select('*').eq('workspace_id', state.workspaceId).maybeSingle()
  state.settings = data
  if (data) $('strategySelect').value = data.strategy
}

async function loadThreads() {
  if (!state.workspaceId) { state.threads=[]; renderThreads(); return }
  const { data, error } = await state.client.from('threads').select('*').eq('workspace_id', state.workspaceId).order('created_at', { ascending:false })
  if (error) return alert(error.message)
  state.threads = data ?? []
  if (state.threadId && !state.threads.some((t) => t.id === state.threadId)) state.threadId = null
  renderThreads()
  if (state.threadId) await openThread(state.threadId)
  else { $('emptyState').classList.remove('hidden'); $('threadView').classList.add('hidden') }
}

function renderThreads() {
  $('threadList').innerHTML = state.threads.map((t) =>
    `<button class="list-item ${t.id===state.threadId?'active':''}" data-thread="${t.id}">${esc(t.title)}<br><span class="subtle">${esc(t.status)}</span></button>`
  ).join('') || '<div class="subtle">No threads yet.</div>'
  document.querySelectorAll('[data-thread]').forEach((el) => el.addEventListener('click', () => openThread(el.dataset.thread)))
}

async function openThread(id) {
  state.threadId = id
  renderThreads()
  const thread = state.threads.find((t) => t.id === id)
  if (!thread) return
  $('emptyState').classList.add('hidden'); $('threadView').classList.remove('hidden')
  $('threadTitle').textContent = thread.title; $('threadObjective').textContent = thread.objective
  $('strategySelect').value = state.settings?.strategy ?? 'balanced'
  await refreshThreadData(); subscribeThread()
}

async function refreshThreadData() {
  if (!state.threadId) return
  const [
    { data: contributions }, { data: decisions }, { data: thread },
    { data: runs }, { data: agentRuns },
  ] = await Promise.all([
    state.client.from('contributions').select('*').eq('thread_id', state.threadId).order('created_at'),
    state.client.from('decisions').select('*').eq('thread_id', state.threadId).order('created_at', { ascending:false }).limit(1),
    state.client.from('threads').select('*').eq('id', state.threadId).single(),
    state.client.from('council_runs').select('*').eq('thread_id', state.threadId).order('created_at', { ascending:false }).limit(10),
    state.client.from('agent_runs').select('*').eq('thread_id', state.threadId).order('created_at', { ascending:false }).limit(30),
  ])

  if (thread) {
    const idx = state.threads.findIndex((t) => t.id === thread.id); if (idx >= 0) state.threads[idx] = thread
    $('threadStatus').textContent = thread.status; $('threadRound').textContent = `Round ${thread.current_round}`; renderThreads()
  }

  renderRuns(runs ?? [])
  renderAgentRuns(agentRuns ?? [])
  renderContributions(contributions ?? [])

  state.decision = decisions?.[0] ?? null
  renderDecision(state.decision)

  const active = (runs ?? []).some((r) => ['queued','running'].includes(r.status))
  $('runCouncilButton').disabled = active
}

function renderRuns(rows) {
  $('runCount').textContent = `${rows.length} recent`
  $('runHistory').innerHTML = rows.map((r) =>
    `<div class="run-row"><div><strong>${esc(r.strategy)}</strong><br><span class="subtle">${fmtTime(r.created_at)}</span></div><div>${esc(r.current_phase || '—')}${r.error ? `<div class="error">${esc(r.error)}</div>` : ''}</div><span class="badge">${esc(r.status)}</span></div>`
  ).join('') || '<div class="subtle">No Council runs yet.</div>'
}

function renderAgentRuns(rows) {
  $('agentRuns').innerHTML = rows.map((r) =>
    `<div class="run-row"><div><strong>${esc(r.provider)}</strong><br><span class="subtle">${esc(r.model || '')}</span></div><div>${esc(r.phase)}${r.error ? `<div class="error">${esc(r.error)}</div>` : ''}</div><span class="badge">${esc(r.status)}</span></div>`
  ).join('') || '<div class="subtle">No provider calls yet.</div>'
}

function renderContributions(rows) {
  $('contributionCount').textContent = `${rows.length} published`
  $('contributions').innerHTML = rows.map((c) => {
    const groups = [
      ['Assumptions', c.assumptions], ['Evidence', c.evidence],
      ['Recommendations', c.recommendations], ['Disagreements', c.disagreements],
    ].filter(([, items]) => Array.isArray(items) && items.length)
    return `<article class="card"><div class="card-head"><h3>${esc(c.agent)} · ${esc(c.kind)} · round ${c.round}</h3><span class="subtle">${esc(c.model || c.provider || '')}${c.confidence==null?'':` · ${Math.round(Number(c.confidence)*100)}%`}</span></div><p>${esc(c.summary)}</p>${groups.map(([name,items]) => `<strong>${name}</strong><ul>${items.map((x)=>`<li>${esc(x)}</li>`).join('')}</ul>`).join('')}</article>`
  }).join('') || '<div class="subtle">No contributions yet.</div>'
}

function renderDecision(d) {
  $('decision').textContent = d ? `${d.decision}${d.rationale ? `\n\n${d.rationale}` : ''}` : 'No synthesis yet.'
  $('decision').classList.toggle('muted', !d)
  $('decisionStatus').classList.toggle('hidden', !d)
  $('decisionStatus').textContent = d?.status ?? ''
  $('decisionActions').classList.toggle('hidden', !d || d.status !== 'proposed')
}

function subscribeThread() {
  clearChannels()
  if (!state.threadId) return
  const refresh = () => refreshThreadData()
  const channel = state.client.channel(`council-thread-${state.threadId}`)
    .on('postgres_changes', { event:'*', schema:'public', table:'contributions', filter:`thread_id=eq.${state.threadId}` }, refresh)
    .on('postgres_changes', { event:'*', schema:'public', table:'decisions', filter:`thread_id=eq.${state.threadId}` }, refresh)
    .on('postgres_changes', { event:'*', schema:'public', table:'threads', filter:`id=eq.${state.threadId}` }, refresh)
    .on('postgres_changes', { event:'*', schema:'public', table:'agent_runs', filter:`thread_id=eq.${state.threadId}` }, refresh)
    .on('postgres_changes', { event:'*', schema:'public', table:'council_runs', filter:`thread_id=eq.${state.threadId}` }, refresh)
    .subscribe()
  state.channels.push(channel)
}

async function reviewDecision(status) {
  if (!state.decision) return
  const { error } = await state.client.from('decisions').update({ status }).eq('id', state.decision.id)
  if (error) return alert(error.message)
  $('runMessage').textContent = status === 'accepted' ? 'Decision accepted.' : 'Decision rejected; thread reopened.'
  await refreshThreadData()
}

$('saveConnection').addEventListener('click', () => { saveConfig($('supabaseUrl').value.trim(), $('supabaseKey').value.trim()); location.reload() })
$('connectionSettingsButton').addEventListener('click', () => showOnly('setupPanel'))
$('signInButton').addEventListener('click', async () => {
  const email = $('email').value.trim(); if (!email) return
  const { error } = await state.client.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href.split('#')[0] } })
  $('authMessage').textContent = error ? error.message : 'Magic link sent. Open it in this browser.'
})
$('signOutButton').addEventListener('click', async () => { await state.client.auth.signOut(); clearChannels(); location.reload() })
document.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => $(el.dataset.close).close()))

$('newWorkspaceButton').addEventListener('click', () => $('workspaceDialog').showModal())
$('workspaceForm').addEventListener('submit', async (e) => {
  e.preventDefault(); const name = $('workspaceName').value.trim(); if (!name) return
  const { data: { user } } = await state.client.auth.getUser()
  const { data, error } = await state.client.from('workspaces').insert({ name, owner_id:user.id }).select('*').single()
  if (error) return alert(error.message)
  $('workspaceDialog').close(); $('workspaceName').value=''; state.workspaceId=data.id; await loadWorkspaces()
})

$('newThreadButton').addEventListener('click', () => $('threadDialog').showModal())
$('threadForm').addEventListener('submit', async (e) => {
  e.preventDefault(); if (!state.workspaceId) return
  const { data: { user } } = await state.client.auth.getUser()
  const payload = { workspace_id:state.workspaceId, created_by:user.id, title:$('newThreadTitle').value.trim(), objective:$('newThreadObjective').value.trim() }
  const { data, error } = await state.client.from('threads').insert(payload).select('*').single()
  if (error) return alert(error.message)
  $('threadDialog').close(); $('newThreadTitle').value=''; $('newThreadObjective').value=''; state.threadId=data.id; await loadThreads(); await openThread(data.id)
})

$('workspaceSettingsButton').addEventListener('click', async () => {
  await loadWorkspaceSettings(); const s = state.settings; if (!s) return
  $('settingsStrategy').value=s.strategy; $('enableOpenAI').checked=s.enable_openai; $('enableAnthropic').checked=s.enable_anthropic; $('enableXAI').checked=s.enable_xai; $('requireApproval').checked=s.require_human_approval
  $('openAIModel').value=s.openai_model; $('openAISynthesisModel').value=s.openai_synthesis_model; $('anthropicModel').value=s.anthropic_model; $('xaiModel').value=s.xai_model
  $('providerTimeout').value=s.provider_timeout_ms; $('maxRetries').value=s.max_retries
  $('settingsDialog').showModal()
})
$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault(); if (!state.workspaceId) return
  const patch = {
    strategy:$('settingsStrategy').value, enable_openai:$('enableOpenAI').checked,
    enable_anthropic:$('enableAnthropic').checked, enable_xai:$('enableXAI').checked,
    require_human_approval:$('requireApproval').checked, openai_model:$('openAIModel').value.trim(),
    openai_synthesis_model:$('openAISynthesisModel').value.trim(), anthropic_model:$('anthropicModel').value.trim(),
    xai_model:$('xaiModel').value.trim(), provider_timeout_ms:Number($('providerTimeout').value),
    max_retries:Number($('maxRetries').value),
  }
  const { data, error } = await state.client.from('workspace_settings').update(patch).eq('workspace_id',state.workspaceId).select('*').single()
  if (error) return alert(error.message)
  state.settings=data; $('strategySelect').value=data.strategy; $('settingsDialog').close()
})

$('runCouncilButton').addEventListener('click', async () => {
  if (!state.threadId) return
  const missing = state.health && !Object.values(state.health.providers || {}).some((p) => p.configured)
  if (missing) { $('runMessage').textContent='No model API keys are configured yet.'; return }
  $('runCouncilButton').disabled=true; $('runMessage').textContent='Council is deliberating…'
  const { data, error } = await state.client.functions.invoke('council-orchestrator', {
    body:{ thread_id:state.threadId, strategy:$('strategySelect').value, idempotency_key:crypto.randomUUID() }
  })
  $('runCouncilButton').disabled=false
  $('runMessage').textContent = error
    ? `Run failed: ${error.message}`
    : data.reused ? 'An existing active run was reused.'
    : data.awaiting_approval ? `Synthesis ready for approval · ${data.proposals} proposals · ${data.critiques} critiques`
    : `Completed · ${data.proposals} proposals · ${data.critiques} critiques`
  await refreshThreadData()
})

$('acceptDecisionButton').addEventListener('click',()=>reviewDecision('accepted'))
$('rejectDecisionButton').addEventListener('click',()=>reviewDecision('rejected'))

$('mapRepoButton').addEventListener('click', async () => {
  const full_name=$('repoFullName').value.trim(); if(!full_name||!state.workspaceId)return
  const { data:{user} }=await state.client.auth.getUser()
  const { error }=await state.client.from('github_repositories').insert({workspace_id:state.workspaceId,full_name,created_by:user.id})
  $('repoMessage').textContent=error?error.message:`Mapped ${full_name}. GitHub events will attach after its signed webhook is configured.`
})

window.addEventListener('hashchange',()=>setTimeout(boot,50))
boot()
