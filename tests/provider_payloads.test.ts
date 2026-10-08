import { buildOpenAIRequest } from '../supabase/functions/_shared/providers/openai.ts'
import { buildAnthropicRequest } from '../supabase/functions/_shared/providers/anthropic.ts'
import { buildXAIRequest } from '../supabase/functions/_shared/providers/xai.ts'
import type { AdapterOptions, ProviderInput } from '../supabase/functions/_shared/providers/types.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const options: AdapterOptions = { model: 'test-model', timeoutMs: 10000, maxRetries: 0, effort: 'medium' }
const input: ProviderInput = {
  threadId: 'thread-1', runId: 'run-1', phase: 'proposal', strategy: 'balanced',
  title: 'Test', objective: 'Choose the safest option', existing: [], githubContext: [], memoryContext: [], taskContext: [], evidenceContext: [],
}

Deno.test('OpenAI request uses reasoning and strict structured output', () => {
  const body: any = buildOpenAIRequest(options, input)
  assert(body.reasoning?.effort === 'medium', 'OpenAI reasoning effort missing')
  assert(body.text?.format?.type === 'json_schema', 'OpenAI JSON schema format missing')
  assert(body.text?.format?.strict === true, 'OpenAI structured output must be strict')
})

Deno.test('Anthropic request uses output_config effort and JSON schema format', () => {
  const body: any = buildAnthropicRequest(options, input)
  assert(body.output_config?.effort === 'medium', 'Anthropic effort missing')
  assert(body.output_config?.format?.type === 'json_schema', 'Anthropic structured output missing')
  assert(body.output_config?.format?.schema?.required?.includes('summary'), 'Anthropic schema missing summary')
  const schemaText = JSON.stringify(body.output_config.format.schema)
  assert(!schemaText.includes('minLength'), 'Anthropic raw schema contains unsupported minLength')
  assert(!schemaText.includes('maxItems'), 'Anthropic raw schema contains unsupported maxItems')
  assert(!schemaText.includes('minimum'), 'Anthropic raw schema contains unsupported numeric constraints')
})

Deno.test('xAI Responses request uses reasoning envelope, cache key and structured output', () => {
  const body: any = buildXAIRequest(options, input)
  assert(body.reasoning?.effort === 'medium', 'xAI reasoning envelope missing')
  assert(!('reasoning_effort' in body), 'Legacy xAI reasoning_effort field must not be used')
  assert(body.prompt_cache_key === 'council:thread-1', 'xAI prompt cache key missing')
  assert(body.text?.format?.type === 'json_schema', 'xAI JSON schema format missing')
})

Deno.test('provider prompt carries memory, tasks and evidence', () => {
  const enriched: ProviderInput = {
    ...input,
    memoryContext: [{ kind:'decision', title:'Keep RLS enabled', content:'All exposed tables require RLS.' }],
    taskContext: [{ title:'Configure webhook', status:'todo', priority:1 }],
    evidenceContext: [{ source_type:'github', title:'PR #4', sha:'abc123' }],
  }
  const body: any = buildOpenAIRequest(options, enriched)
  const prompt = String(body.input)
  assert(prompt.includes('Institutional memory:'), 'Memory section missing')
  assert(prompt.includes('Keep RLS enabled'), 'Memory content missing')
  assert(prompt.includes('Configure webhook'), 'Task content missing')
  assert(prompt.includes('PR #4'), 'Evidence content missing')
})
