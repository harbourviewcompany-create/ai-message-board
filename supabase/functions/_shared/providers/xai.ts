import { buildPrompt } from './prompt.ts'
import { extractJson } from './normalize.ts'
import { contributionSchema } from './schema.ts'
import { fetchWithRetry } from './http.ts'
import type { AdapterOptions, ProviderAdapter, ProviderInput, ProviderResult } from './types.ts'

export function buildXAIRequest(options: AdapterOptions, input: ProviderInput) {
  return {
    model: options.model,
    store: false,
    input: buildPrompt(input),
    reasoning: { effort: options.effort },
    prompt_cache_key: `council:${input.threadId}`,
    text: {
      format: {
        type: 'json_schema',
        name: 'council_contribution',
        strict: true,
        schema: contributionSchema,
      },
    },
  }
}

export function xAIAdapter(options: AdapterOptions): ProviderAdapter {
  const apiKey = Deno.env.get('XAI_API_KEY') ?? ''

  return {
    name: 'xai',
    model: options.model,
    configured: Boolean(apiKey),
    async run(input: ProviderInput): Promise<ProviderResult> {
      const response = await fetchWithRetry(
        'https://api.x.ai/v1/responses',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(buildXAIRequest(options, input)),
        },
        options.timeoutMs,
        options.maxRetries,
      )

      if (!response.ok) throw new Error(`xAI ${response.status}: ${await response.text()}`)
      const body = await response.json()
      const outputText = body.output_text ??
        body.output?.flatMap((item: any) => item.content ?? [])
          .find((content: any) => content.type === 'output_text')?.text
      if (!outputText) throw new Error('xAI response contained no output text')

      return {
        provider: 'xai',
        model: options.model,
        normalized: extractJson(outputText),
        usage: body.usage ?? {},
      }
    },
  }
}
