import { compactContributions, compactGithubContext } from '../supabase/functions/_shared/context.ts'
import type { SharedContribution } from '../supabase/functions/_shared/providers/types.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function row(summary: string): SharedContribution {
  return { agent:'ChatGPT', provider:'openai', model:'test', kind:'message', round:0, summary, assumptions:[], evidence:[], recommendations:[], disagreements:[], confidence:null }
}

Deno.test('context compaction preserves the newest contributions within budget', () => {
  const rows = [row('old '.repeat(900)), row('middle '.repeat(500)), row('newest answer')]
  const compact = compactContributions(rows, 1200)
  assert(compact.length >= 1, 'Expected at least one contribution')
  assert(compact.at(-1)?.summary === 'newest answer', 'Newest contribution must be retained')
  assert(JSON.stringify(compact).length < 3000, 'Compacted context grew unexpectedly')
})

Deno.test('GitHub context is bounded and strips oversized metadata', () => {
  const refs = Array.from({length:20}, (_, i) => ({ repository_full_name:'owner/repo', ref_type:'commit', sha:String(i), metadata:{ blob:'x'.repeat(3000) } }))
  const compact = compactGithubContext(refs, 2200)
  assert(compact.length > 0 && compact.length < refs.length, 'GitHub context budget was not applied')
})
