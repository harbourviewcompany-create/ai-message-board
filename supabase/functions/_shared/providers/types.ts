export type Phase = 'proposal' | 'critique' | 'synthesis'

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
  phase: Phase
  title: string
  objective: string
  existing: SharedContribution[]
  githubContext: unknown[]
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

export interface ProviderAdapter {
  name: ProviderResult['provider']
  model: string
  configured: boolean
  run(input: ProviderInput): Promise<ProviderResult>
}
