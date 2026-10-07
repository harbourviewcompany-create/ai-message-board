import type { NormalizedResult } from './types.ts'

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean).slice(0, 12)
}

function clampConfidence(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(1, n))
}

export function extractJson(text: string): NormalizedResult {
  const trimmed = text.trim()
  let candidate = trimmed
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) candidate = fenced[1].trim()
  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) candidate = candidate.slice(start, end + 1)
  }

  const parsed = JSON.parse(candidate)
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
  if (!summary) throw new Error('Provider response did not include a summary')

  return {
    summary,
    assumptions: strings(parsed.assumptions),
    evidence: strings(parsed.evidence),
    recommendations: strings(parsed.recommendations),
    disagreements: strings(parsed.disagreements),
    confidence: clampConfidence(parsed.confidence),
  }
}
