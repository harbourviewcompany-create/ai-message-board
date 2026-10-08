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
  const selected: unknown[] = []
  let used = 0

  for (const raw of rows) {
    const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const compact = {
      repository_full_name: clip(row.repository_full_name, 160),
      ref_type: clip(row.ref_type, 40),
      ref_number: row.ref_number == null ? null : clip(row.ref_number, 40),
      sha: row.sha == null ? null : clip(row.sha, 80),
      path: row.path == null ? null : clip(row.path, 240),
      url: row.url == null ? null : clip(row.url, 500),
      metadata: row.metadata == null ? null : clip(JSON.stringify(row.metadata), 900),
    }
    const size = JSON.stringify(compact).length
    if (selected.length && used + size > maxChars) break
    selected.push(compact)
    used += size
  }

  return selected
}
