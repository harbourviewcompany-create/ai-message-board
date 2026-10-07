export const contributionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } },
    recommendations: { type: 'array', items: { type: 'string' } },
    disagreements: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: ['summary', 'assumptions', 'evidence', 'recommendations', 'disagreements', 'confidence'],
} as const
