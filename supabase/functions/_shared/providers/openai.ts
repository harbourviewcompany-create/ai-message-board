import { buildPrompt } from './prompt.ts'
import { extractJson } from './normalize.ts'
import { contributionSchema } from './schema.ts'
import { fetchWithRetry } from './http.ts'
import type { AdapterOptions, ProviderAdapter, ProviderInput, ProviderResult } from './types.ts'

export function openAIAdapter(options: AdapterOptions): ProviderAdapter {
  const apiKey = Deno.env.get('OPENAI_API_KEY') ?? ''

  return {
    name: 'openai',
    model: options.model,
    configured: Boolean(apiKey),
    async run(input: ProviderInput): Promise<ProviderResult> {
      const response = await fetchWithRetry(
        'https://api.openai.com/v1/responses',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: options.model,
            store: false,
            instructions: 'Follow the Council protocol. Produce only the structured contribution.',
            input: buildPrompt(input),
            reasoning: { effort: options.effort },
            text: {
              format: {
                type: 'json_schema',
                name: 'council_contribution',
                strict: true,
                schema: contributionSchema,
              },
            },
          }),
        },
        options.timeoutMs,
        options.maxRetries,
      )

      if (!response.ok) throw new Error(`OpenAI ${response.status}: ${await response.text()}`)
      const body = await response.json()
      const text = body.output_text ??
        body.output?.flatMap((item: any) => item.content ?? [])
          .find((c: any) => c.type === 'output_text')?.text
      if (!text) throw new Error('OpenAI response contained no output text')

      return {
        provider: 'openai',
        model: options.model,
        normalized: extractJson(text),
        usage: body.usage ?? {},
      }
    },
  }
}
