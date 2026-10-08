function clip(value: unknown, max = 4000): string | null {
  if (value == null) return null
  const text = String(value)
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

export function githubEventRef(payload: any, event: string) {
  const repo = payload.repository?.full_name ?? null
  if (!repo) return null
  if (event === 'pull_request' || event === 'pull_request_review' || event === 'pull_request_review_comment') {
    const pr = payload.pull_request
    const number = payload.number ?? pr?.number
    return { ref_type: 'pull_request', ref_number: number == null ? null : String(number), sha: pr?.head?.sha ?? null, url: pr?.html_url ?? null }
  }
  if (event === 'issues' || event === 'issue_comment') {
    const issue = payload.issue
    return { ref_type: 'issue', ref_number: issue?.number == null ? null : String(issue.number), sha: null, url: issue?.html_url ?? null }
  }
  if (event === 'push') return { ref_type: 'commit', ref_number: null, sha: payload.after ?? null, url: payload.head_commit?.url ?? null }
  if (event === 'workflow_run') return { ref_type: 'workflow', ref_number: payload.workflow_run?.id == null ? null : String(payload.workflow_run.id), sha: payload.workflow_run?.head_sha ?? null, url: payload.workflow_run?.html_url ?? null }
  return null
}

export function normalizeGithubPayload(payload: any, event: string) {
  const repository = payload.repository ? {
    id: payload.repository.id ?? null,
    full_name: clip(payload.repository.full_name, 200),
    private: Boolean(payload.repository.private),
    default_branch: clip(payload.repository.default_branch, 120),
    html_url: clip(payload.repository.html_url, 500),
  } : null

  const sender = payload.sender ? { id: payload.sender.id ?? null, login: clip(payload.sender.login, 120) } : null
  const base: Record<string, unknown> = { action: clip(payload.action, 80), repository, sender }

  if (event === 'push') {
    base.ref = clip(payload.ref, 240)
    base.before = clip(payload.before, 80)
    base.after = clip(payload.after, 80)
    base.forced = Boolean(payload.forced)
    base.head_commit = payload.head_commit ? {
      id: clip(payload.head_commit.id, 80), message: clip(payload.head_commit.message),
      timestamp: clip(payload.head_commit.timestamp, 80), url: clip(payload.head_commit.url, 500),
      author: clip(payload.head_commit.author?.name, 160),
    } : null
    base.commits = Array.isArray(payload.commits) ? payload.commits.slice(0, 20).map((commit: any) => ({
      id: clip(commit.id, 80), message: clip(commit.message, 1000), url: clip(commit.url, 500), author: clip(commit.author?.name, 160),
    })) : []
  }

  if (event.startsWith('pull_request')) {
    const pr = payload.pull_request
    base.number = payload.number ?? pr?.number ?? null
    base.pull_request = pr ? {
      number: pr.number ?? null, title: clip(pr.title, 500), state: clip(pr.state, 40), draft: Boolean(pr.draft),
      merged: Boolean(pr.merged), html_url: clip(pr.html_url, 500), updated_at: clip(pr.updated_at, 80),
      user: clip(pr.user?.login, 120), head: { sha: clip(pr.head?.sha, 80), ref: clip(pr.head?.ref, 240) },
      base: { sha: clip(pr.base?.sha, 80), ref: clip(pr.base?.ref, 240) },
    } : null
  }

  if (event === 'issues' || event === 'issue_comment') {
    const issue = payload.issue
    base.issue = issue ? {
      number: issue.number ?? null, title: clip(issue.title, 500), state: clip(issue.state, 40),
      html_url: clip(issue.html_url, 500), updated_at: clip(issue.updated_at, 80), user: clip(issue.user?.login, 120),
    } : null
    if (payload.comment) base.comment = { id: payload.comment.id ?? null, html_url: clip(payload.comment.html_url, 500), user: clip(payload.comment.user?.login, 120), body: clip(payload.comment.body, 4000) }
  }

  if (event === 'workflow_run') {
    const run = payload.workflow_run
    base.workflow_run = run ? {
      id: run.id ?? null, name: clip(run.name, 300), event: clip(run.event, 80), status: clip(run.status, 40),
      conclusion: clip(run.conclusion, 40), head_sha: clip(run.head_sha, 80), html_url: clip(run.html_url, 500), run_number: run.run_number ?? null,
    } : null
  }

  return base
}
