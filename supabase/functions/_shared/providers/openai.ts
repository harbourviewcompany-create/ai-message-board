import { buildPrompt } from './prompt.ts'
import { extractJson } from './normalize.ts'
import type { ProviderAdapter, ProviderInput, ProviderResult } from './types.ts'

export function openAIAdapter(): ProviderAdapter {
  const apiKey = Deno.env.get('OPENAI_API_KEY') ?? ''
  const model = Deno.env.get('OPENAI_MODEL') ?? 'gpt-6-astra'

  return {
    name: 'openai',
    model,
    configured: Boolean(apiKey),
    async run(input: ProviderInput): Promise<ProviderResult> {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          instructions: 'Follow the Council protocol exactly. Return JSON only.',
          input: buildPrompt(input),
          reasoning: { effort: input.phase === 'synthesis' ? 'high' : 'medium' },
        }),
        signal: AbortSignal.timeout(45_000),
      })

      if (!response.ok) throw new Error(`OpenAI ${response.status}: ${await response.text()}`)
      const body = await response.json()
      const text = body.output_text ?? body.output?.flatMap((item: any) => item.content ?? []).find((c: any) => c.type === 'output_text')?.text
      if (!text) throw new Error('OpenAI response contained no output text')

      return {
        provider: 'openai',
        model,
        normalized: extractJson(text),
        usage: body.usage ?? {},
      }
    },
  }
}
