import type { ProviderInput } from './types.ts'

const RULES = `
You are one participant in Council, a multi-model deliberation system.
Do not reveal or request hidden chain-of-thought. Publish only concise reasoning summaries that are useful to collaborators.
Return ONLY valid JSON with this exact shape:
{
  "summary": "string",
  "assumptions": ["string"],
  "evidence": ["string"],
  "recommendations": ["string"],
  "disagreements": ["string"],
  "confidence": 0.0
}
confidence must be between 0 and 1. Keep arrays concise. If evidence is unavailable, say so explicitly rather than inventing it.
`

export function buildPrompt(input: ProviderInput) {
  const peerContext = input.existing.length
    ? JSON.stringify(input.existing, null, 2)
    : 'No peer contributions have been published yet.'
  const githubContext = input.githubContext.length
    ? JSON.stringify(input.githubContext, null, 2)
    : 'No GitHub context is attached.'

  const phaseInstruction = input.phase === 'proposal'
    ? 'Independently propose the best approach. Do not anchor on nonexistent peer views.'
    : input.phase === 'critique'
      ? 'Critique the peer proposals. Identify agreements, disagreements, missing evidence, risks, and concrete improvements. Revise your recommendation where appropriate.'
      : 'Synthesize the strongest available ideas and disagreements into one practical decision. Preserve meaningful dissent and uncertainty.'

  return `${RULES}\nPhase: ${input.phase}\n${phaseInstruction}\n\nThread: ${input.title}\nObjective:\n${input.objective}\n\nPublished peer context:\n${peerContext}\n\nGitHub context:\n${githubContext}`
}
