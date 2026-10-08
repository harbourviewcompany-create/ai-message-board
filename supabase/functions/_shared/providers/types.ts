export type Phase = 'proposal' | 'critique' | 'synthesis' | 'message'
export type CouncilStrategy = 'balanced' | 'quality' | 'fast' | 'economy' | 'adversarial'
export type ReasoningEffort = 'low' | 'medium' | 'high'

export interface SharedContribution {
  agent: string
  provider: string | null
  model: string | null
  kind: string
  round: number
  summary: string
  assumptions: string[]
  evidence: string[]
  recommendations: string[]
  disagreements: string[]
  confidence: number | null
}

export interface ProviderInput {
  threadId: string
  runId: string
  phase: Phase
  strategy: CouncilStrategy
  title: string
  objective: string
  existing: SharedContribution[]
  githubContext: unknown[]
  memoryContext: unknown[]
  taskContext: unknown[]
  evidenceContext: unknown[]
}

export interface NormalizedResult {
  summary: string
  assumptions: string[]
  evidence: string[]
  recommendations: string[]
  disagreements: string[]
  confidence: number | null
}

export interface ProviderResult {
  provider: 'openai' | 'anthropic' | 'xai'
  model: string
  normalized: NormalizedResult
  usage: Record<string, unknown>
}

export interface AdapterOptions {
  model: string
  timeoutMs: number
  maxRetries: number
  effort: ReasoningEffort
}

export interface ProviderAdapter {
  name: ProviderResult['provider']
  model: string
  configured: boolean
  run(input: ProviderInput): Promise<ProviderResult>
}
