import type { SharedContribution } from './providers/types.ts'

function clip(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function clipList(value: unknown, maxItems = 4, maxItemChars = 500): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => clip(item, maxItemChars))
    .filter(Boolean)
    .slice(0, maxItems)
}

function withinBudget(rows: unknown[], maxChars: number) {
  const selected: unknown[] = []
  let used = 0

  for (const row of rows) {
    const size = JSON.stringify(row).length
    if (selected.length && used + size > maxChars) break
    selected.push(row)
    used += size
  }

  return selected
}

export function compactContributions(
  rows: SharedContribution[],
  maxChars = 18000,
): SharedContribution[] {
  const compacted = rows.map((row) => ({
    agent: clip(row.agent, 60),
    provider: row.provider ? clip(row.provider, 30) : null,
    model: row.model ? clip(row.model, 80) : null,
    kind: clip(row.kind, 40),
    round: Number(row.round ?? 0),
    summary: clip(row.summary, 2200),
    assumptions: clipList(row.assumptions),
    evidence: clipList(row.evidence),
    recommendations: clipList(row.recommendations),
    disagreements: clipList(row.disagreements),
    confidence: row.confidence == null ? null : Number(row.confidence),
  }))

  const selected: SharedContribution[] = []
  let used = 0
  for (let i = compacted.length - 1; i >= 0; i--) {
    const row = compacted[i]
    const size = JSON.stringify(row).length
    if (selected.length && used + size > maxChars) break
    selected.push(row)
    used += size
  }
  return selected.reverse()
}

export function compactGithubContext(rows: unknown[], maxChars = 6000): unknown[] {
  const compacted = rows.map((raw) => {
    const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    return {
      repository_full_name: clip(row.repository_full_name, 160),
      ref_type: clip(row.ref_type, 40),
      ref_number: row.ref_number == null ? null : clip(row.ref_number, 40),
      sha: row.sha == null ? null : clip(row.sha, 80),
      path: row.path == null ? null : clip(row.path, 240),
      url: row.url == null ? null : clip(row.url, 500),
      metadata: row.metadata == null ? null : clip(JSON.stringify(row.metadata), 900),
    }
  })
  return withinBudget(compacted, maxChars)
}

export function compactMemoryContext(rows: unknown[], maxChars = 7000): unknown[] {
  const compacted = rows.map((raw) => {
    const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    return {
      kind: clip(row.kind, 40),
      title: clip(row.title, 240),
      content: clip(row.content, 1800),
      confidence: row.confidence == null ? null : Number(row.confidence),
      thread_id: row.thread_id == null ? null : clip(row.thread_id, 80),
      updated_at: row.updated_at == null ? null : clip(row.updated_at, 80),
    }
  })
  return withinBudget(compacted, maxChars)
}

export function compactTaskContext(rows: unknown[], maxChars = 4500): unknown[] {
  const compacted = rows.map((raw) => {
    const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    return {
      title: clip(row.title, 240),
      description: clip(row.description, 900),
      status: clip(row.status, 40),
      priority: Number(row.priority ?? 3),
      owner_type: clip(row.owner_type, 40),
      owner: row.owner == null ? null : clip(row.owner, 160),
      due_at: row.due_at == null ? null : clip(row.due_at, 80),
      github_url: row.github_url == null ? null : clip(row.github_url, 500),
    }
  })
  return withinBudget(compacted, maxChars)
}

export function compactEvidenceContext(rows: unknown[], maxChars = 5000): unknown[] {
  const compacted = rows.map((raw) => {
    const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    return {
      source_type: clip(row.source_type, 40),
      title: row.title == null ? null : clip(row.title, 240),
      url: row.url == null ? null : clip(row.url, 500),
      repository_full_name: row.repository_full_name == null ? null : clip(row.repository_full_name, 160),
      sha: row.sha == null ? null : clip(row.sha, 80),
      path: row.path == null ? null : clip(row.path, 240),
      excerpt: row.excerpt == null ? null : clip(row.excerpt, 1000),
    }
  })
  return withinBudget(compacted, maxChars)
}
