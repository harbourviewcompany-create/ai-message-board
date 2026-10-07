export const contributionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', minLength: 1 },
    assumptions: { type: 'array', items: { type: 'string' }, maxItems: 12 },
    evidence: { type: 'array', items: { type: 'string' }, maxItems: 12 },
    recommendations: { type: 'array', items: { type: 'string' }, maxItems: 12 },
    disagreements: { type: 'array', items: { type: 'string' }, maxItems: 12 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['summary', 'assumptions', 'evidence', 'recommendations', 'disagreements', 'confidence'],
} as const
