import { buildPrompt } from './prompt.ts'
import { extractJson } from './normalize.ts'
import type { ProviderAdapter, ProviderInput, ProviderResult } from './types.ts'

export function anthropicAdapter(): ProviderAdapter {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
  const model = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-sonnet-5-5'

  return {
    name: 'anthropic',
    model,
    configured: Boolean(apiKey),
    async run(input: ProviderInput): Promise<ProviderResult> {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2400,
          system: 'Follow the Council protocol exactly. Return JSON only. Do not provide hidden chain-of-thought.',
          messages: [{ role: 'user', content: buildPrompt(input) }],
        }),
        signal: AbortSignal.timeout(45_000),
      })

      if (!response.ok) throw new Error(`Anthropic ${response.status}: ${await response.text()}`)
      const body = await response.json()
      const text = body.content?.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n')
      if (!text) throw new Error('Anthropic response contained no text')

      return {
        provider: 'anthropic',
        model,
        normalized: extractJson(text),
        usage: body.usage ?? {},
      }
    },
  }
}
