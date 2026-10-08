import { buildPrompt } from './prompt.ts'
import { extractJson } from './normalize.ts'
import { contributionSchema } from './schema.ts'
import { fetchWithRetry } from './http.ts'
import type { AdapterOptions, ProviderAdapter, ProviderInput, ProviderResult } from './types.ts'

export function buildAnthropicRequest(options: AdapterOptions, input: ProviderInput) {
  return {
    model: options.model,
    max_tokens: 2400,
    system: 'Follow the Council protocol. Return only the structured contribution. Never expose hidden chain-of-thought.',
    output_config: {
      effort: options.effort,
      format: {
        type: 'json_schema',
        schema: contributionSchema,
      },
    },
    messages: [{ role: 'user', content: buildPrompt(input) }],
  }
}

export function anthropicAdapter(options: AdapterOptions): ProviderAdapter {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''

  return {
    name: 'anthropic',
    model: options.model,
    configured: Boolean(apiKey),
    async run(input: ProviderInput): Promise<ProviderResult> {
      const response = await fetchWithRetry(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(buildAnthropicRequest(options, input)),
        },
        options.timeoutMs,
        options.maxRetries,
      )

      if (!response.ok) throw new Error(`Anthropic ${response.status}: ${await response.text()}`)
      const body = await response.json()
      if (body.stop_reason === 'refusal') throw new Error('Anthropic refused the request')
      if (body.stop_reason === 'model_context_window_exceeded') throw new Error('Anthropic context window exceeded')

      const outputText = body.content
        ?.filter((item: any) => item.type === 'text')
        .map((item: any) => item.text)
        .join('\n')
      if (!outputText) throw new Error('Anthropic response contained no text')

      return {
        provider: 'anthropic',
        model: options.model,
        normalized: extractJson(outputText),
        usage: body.usage ?? {},
      }
    },
  }
}
