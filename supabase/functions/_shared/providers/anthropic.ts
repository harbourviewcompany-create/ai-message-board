import { buildPrompt } from './prompt.ts'
import { extractJson } from './normalize.ts'
import { fetchWithRetry } from './http.ts'
import type { AdapterOptions, ProviderAdapter, ProviderInput, ProviderResult } from './types.ts'

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
          body: JSON.stringify({
            model: options.model,
            max_tokens: 2200,
            system: 'Follow the Council protocol. Return one JSON object matching the requested fields. Do not expose hidden chain-of-thought.',
            output_config: { effort: options.effort },
            messages: [{ role: 'user', content: buildPrompt(input) }],
          }),
        },
        options.timeoutMs,
        options.maxRetries,
      )

      if (!response.ok) throw new Error(`Anthropic ${response.status}: ${await response.text()}`)
      const body = await response.json()

      if (body.stop_reason === 'refusal') {
        throw new Error('Anthropic refused the request')
      }

      const text = body.content
        ?.filter((x: any) => x.type === 'text')
        .map((x: any) => x.text)
        .join('\n')
      if (!text) throw new Error('Anthropic response contained no text')

      return {
        provider: 'anthropic',
        model: options.model,
        normalized: extractJson(text),
        usage: body.usage ?? {},
      }
    },
  }
}
