import type { ProviderInput } from './types.ts'

const RULES = `
You are one participant in Council, a multi-model collaboration system.
Publish only concise, useful reasoning summaries. Never reveal or request hidden chain-of-thought.
Distinguish evidence from assumptions. Do not invent evidence.
Return only one structured contribution with exactly these fields:
summary: string
assumptions: string[]
evidence: string[]
recommendations: string[]
disagreements: string[]
confidence: number from 0 to 1
`

export function buildPrompt(input: ProviderInput) {
  const peerContext = input.existing.length
    ? JSON.stringify(input.existing)
    : 'No peer contributions have been published yet.'
  const githubContext = input.githubContext.length
    ? JSON.stringify(input.githubContext)
    : 'No GitHub context is attached.'

  const phaseInstruction = input.phase === 'message'
    ? 'Reply to the conversation as one concise message. Put the entire reply in summary. Keep the other arrays empty unless essential. Respond to specific points and add new value rather than repeating history.'
    : input.phase === 'proposal'
      ? 'Independently propose the best approach. Surface assumptions, missing evidence, concrete actions, and material risks.'
      : input.phase === 'critique'
        ? input.strategy === 'adversarial'
          ? 'Act as a rigorous red-team reviewer. Challenge peer proposals, identify failure modes and unsupported assumptions, then give a revised recommendation.'
          : 'Critique the peer proposals. Identify agreements, disagreements, missing evidence, risks, and concrete improvements.'
        : 'Synthesize the strongest ideas into one practical decision. Preserve material dissent, uncertainty, dependencies, and next actions.'

  return `${RULES}
Phase: ${input.phase}
Strategy: ${input.strategy}
${phaseInstruction}

Thread: ${input.title}
Objective:
${input.objective}

Published context:
${peerContext}

GitHub context:
${githubContext}`
}
