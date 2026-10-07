import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.1'

const $ = (id) => document.getElementById(id)
const state = { client: null, user: null, workspaces: [], workspaceId: null, threads: [], threadId: null, channels: [] }

function config() {
  try { return JSON.parse(localStorage.getItem('council.supabase') || 'null') } catch { return null }
}
function saveConfig(url, key) { localStorage.setItem('council.supabase', JSON.stringify({ url, key })) }
function clearChannels() { state.channels.forEach((c) => state.client?.removeChannel(c)); state.channels = [] }
function setConnection(text) { $('connectionBadge').textContent = text }
function showOnly(id) {
  ['setupPanel', 'authPanel', 'appPanel'].forEach((x) => $(x).classList.toggle('hidden', x !== id))
}
function esc(value='') { return String(value).replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])) }

async function boot() {
  const c = config()
  if (!c?.url || !c?.key) { showOnly('setupPanel'); setConnection('Not configured'); return }
  $('supabaseUrl').value = c.url
  $('supabaseKey').value = c.key
  state.client = createClient(c.url, c.key)
  const { data } = await state.client.auth.getSession()
  state.user = data.session?.user ?? null
  if (!state.user) { showOnly('authPanel'); setConnection('Connected'); return }
  $('signOutButton').classList.remove('hidden')
  showOnly('appPanel'); setConnection(state.user.email ?? 'Signed in')
  await loadWorkspaces()
}

async function loadWorkspaces() {
  const { data, error } = await state.client.from('workspaces').select('*').order('created_at')
  if (error) return alert(error.message)
  state.workspaces = data ?? []
  if (!state.workspaceId && state.workspaces.length) state.workspaceId = state.workspaces[0].id
  renderWorkspaces()
  await loadThreads()
}
function renderWorkspaces() {
  $('workspaceList').innerHTML = state.workspaces.map((w) => `<button class="list-item ${w.id===state.workspaceId?'active':''}" data-workspace="${w.id}">${esc(w.name)}</button>`).join('') || '<div class="subtle">No workspaces yet.</div>'
  document.querySelectorAll('[data-workspace]').forEach((el) => el.addEventListener('click', async () => { state.workspaceId = el.dataset.workspace; state.threadId = null; renderWorkspaces(); await loadThreads() }))
  $('newThreadButton').disabled = !state.workspaceId
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
  $('threadList').innerHTML = state.threads.map((t) => `<button class="list-item ${t.id===state.threadId?'active':''}" data-thread="${t.id}">${esc(t.title)}<br><span class="subtle">${esc(t.status)}</span></button>`).join('') || '<div class="subtle">No threads yet.</div>'
  document.querySelectorAll('[data-thread]').forEach((el) => el.addEventListener('click', () => openThread(el.dataset.thread)))
}
async function openThread(id) {
  state.threadId = id
  renderThreads()
  const thread = state.threads.find((t) => t.id === id)
  if (!thread) return
  $('emptyState').classList.add('hidden'); $('threadView').classList.remove('hidden')
  $('threadTitle').textContent = thread.title
  $('threadObjective').textContent = thread.objective
  $('threadStatus').textContent = thread.status
  $('threadRound').textContent = `Round ${thread.current_round}`
  await refreshThreadData()
  subscribeThread()
}
async function refreshThreadData() {
  if (!state.threadId) return
  const [{ data: contributions }, { data: decisions }, { data: thread }] = await Promise.all([
    state.client.from('contributions').select('*').eq('thread_id', state.threadId).order('created_at'),
    state.client.from('decisions').select('*').eq('thread_id', state.threadId).order('created_at', { ascending:false }).limit(1),
    state.client.from('threads').select('*').eq('id', state.threadId).single(),
  ])
  if (thread) {
    const idx = state.threads.findIndex((t) => t.id === thread.id); if (idx >= 0) state.threads[idx] = thread
    $('threadStatus').textContent = thread.status; $('threadRound').textContent = `Round ${thread.current_round}`; renderThreads()
  }
  renderContributions(contributions ?? [])
  const d = decisions?.[0]
  $('decision').textContent = d ? `${d.decision}${d.rationale ? `\n\n${d.rationale}` : ''}` : 'No synthesis yet.'
  $('decision').classList.toggle('muted', !d)
}
function renderContributions(rows) {
  $('contributionCount').textContent = `${rows.length} published`
  $('contributions').innerHTML = rows.map((c) => {
    const groups = [
      ['Assumptions', c.assumptions], ['Evidence', c.evidence], ['Recommendations', c.recommendations], ['Disagreements', c.disagreements],
    ].filter(([, items]) => Array.isArray(items) && items.length)
    return `<article class="card"><div class="card-head"><h3>${esc(c.agent)} · ${esc(c.kind)} · round ${c.round}</h3><span class="subtle">${esc(c.model || c.provider || '')}${c.confidence==null?'':` · ${Math.round(Number(c.confidence)*100)}%`}</span></div><p>${esc(c.summary)}</p>${groups.map(([name,items]) => `<strong>${name}</strong><ul>${items.map((x)=>`<li>${esc(x)}</li>`).join('')}</ul>`).join('')}</article>`
  }).join('') || '<div class="subtle">No contributions yet.</div>'
}
function subscribeThread() {
  clearChannels()
  if (!state.threadId) return
  const channel = state.client.channel(`council-thread-${state.threadId}`)
    .on('postgres_changes', { event:'*', schema:'public', table:'contributions', filter:`thread_id=eq.${state.threadId}` }, refreshThreadData)
    .on('postgres_changes', { event:'*', schema:'public', table:'decisions', filter:`thread_id=eq.${state.threadId}` }, refreshThreadData)
    .on('postgres_changes', { event:'*', schema:'public', table:'threads', filter:`id=eq.${state.threadId}` }, refreshThreadData)
    .on('postgres_changes', { event:'*', schema:'public', table:'agent_runs', filter:`thread_id=eq.${state.threadId}` }, refreshThreadData)
    .subscribe()
  state.channels.push(channel)
}

$('saveSettings').addEventListener('click', () => { saveConfig($('supabaseUrl').value.trim(), $('supabaseKey').value.trim()); location.reload() })
$('settingsButton').addEventListener('click', () => showOnly('setupPanel'))
$('signInButton').addEventListener('click', async () => {
  const email = $('email').value.trim(); if (!email) return
  const { error } = await state.client.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href.split('#')[0] } })
  $('authMessage').textContent = error ? error.message : 'Magic link sent. Open it in this browser.'
})
$('signOutButton').addEventListener('click', async () => { await state.client.auth.signOut(); clearChannels(); location.reload() })

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
$('runCouncilButton').addEventListener('click', async () => {
  if (!state.threadId) return
  $('runCouncilButton').disabled = true; $('runMessage').textContent='Council is deliberating…'
  const { data, error } = await state.client.functions.invoke('council-orchestrator', { body: { thread_id:state.threadId } })
  $('runCouncilButton').disabled = false
  $('runMessage').textContent = error ? `Run failed: ${error.message}` : `Completed: ${data.proposals} proposals, ${data.critiques} critiques.`
  await refreshThreadData()
})
$('mapRepoButton').addEventListener('click', async () => {
  const full_name = $('repoFullName').value.trim(); if (!full_name || !state.workspaceId) return
  const { data: { user } } = await state.client.auth.getUser()
  const { error } = await state.client.from('github_repositories').insert({ workspace_id:state.workspaceId, full_name, created_by:user.id })
  $('repoMessage').textContent = error ? error.message : `Mapped ${full_name}. Configure its webhook to send events to Council.`
})

window.addEventListener('hashchange', () => setTimeout(boot, 50))
boot()
