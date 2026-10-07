import type { ProviderInput } from './types.ts'

const RULES = `
You are one participant in Council, a multi-model deliberation system.
Publish only concise, useful reasoning summaries. Never reveal or request hidden chain-of-thought.
Distinguish facts/evidence from assumptions. Do not invent evidence.
Return only the requested structured contribution.
`

export function buildPrompt(input: ProviderInput) {
  const peerContext = input.existing.length
    ? JSON.stringify(input.existing, null, 2)
    : 'No peer contributions have been published yet.'
  const githubContext = input.githubContext.length
    ? JSON.stringify(input.githubContext, null, 2)
    : 'No GitHub context is attached.'

  const phaseInstruction = input.phase === 'proposal'
    ? 'Independently propose the best approach before seeing peer proposals. Surface assumptions, missing evidence, concrete actions, and material risks.'
    : input.phase === 'critique'
      ? input.strategy === 'adversarial'
        ? 'Act as a rigorous red-team reviewer. Challenge peer proposals, identify failure modes and unsupported assumptions, then give a revised recommendation.'
        : 'Critique peer proposals. Identify agreements, disagreements, missing evidence, risks, and concrete improvements. Revise your recommendation where appropriate.'
      : 'Synthesize the strongest ideas into one practical decision. Preserve material dissent, uncertainty, dependencies, and the next concrete actions.'

  return `${RULES}
Phase: ${input.phase}
Strategy: ${input.strategy}
${phaseInstruction}

Thread: ${input.title}
Objective:
${input.objective}

Published peer context:
${peerContext}

GitHub context:
${githubContext}`
}
