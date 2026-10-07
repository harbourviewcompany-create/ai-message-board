import { buildPrompt } from './prompt.ts'
import { extractJson } from './normalize.ts'
import type { ProviderAdapter, ProviderInput, ProviderResult } from './types.ts'

export function xAIAdapter(): ProviderAdapter {
  const apiKey = Deno.env.get('XAI_API_KEY') ?? ''
  const model = Deno.env.get('XAI_MODEL') ?? 'grok-4.7'

  return {
    name: 'xai',
    model,
    configured: Boolean(apiKey),
    async run(input: ProviderInput): Promise<ProviderResult> {
      const response = await fetch('https://api.x.ai/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: buildPrompt(input),
        }),
        signal: AbortSignal.timeout(45_000),
      })

      if (!response.ok) throw new Error(`xAI ${response.status}: ${await response.text()}`)
      const body = await response.json()
      const text = body.output_text ?? body.output?.flatMap((item: any) => item.content ?? []).find((c: any) => c.type === 'output_text')?.text
      if (!text) throw new Error('xAI response contained no output text')

      return {
        provider: 'xai',
        model,
        normalized: extractJson(text),
        usage: body.usage ?? {},
      }
    },
  }
}
