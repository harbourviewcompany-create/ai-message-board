import { compactContributions, compactEvidenceContext, compactGithubContext, compactMemoryContext, compactTaskContext } from '../supabase/functions/_shared/context.ts'
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

Deno.test('workspace context helpers bound long memory, tasks and evidence', () => {
  const memory = compactMemoryContext([{ kind:'note', title:'A', content:'x'.repeat(10000), updated_at:new Date().toISOString() }], 2500)
  const tasks = compactTaskContext([{ title:'Task', description:'y'.repeat(5000), status:'todo', priority:1, owner_type:'human' }], 1800)
  const evidence = compactEvidenceContext([{ source_type:'url', title:'Source', url:'https://example.com', excerpt:'z'.repeat(5000) }], 1800)
  assert(JSON.stringify(memory).length < 3000, 'Memory context exceeded budget')
  assert(JSON.stringify(tasks).length < 2500, 'Task context exceeded budget')
  assert(JSON.stringify(evidence).length < 2500, 'Evidence context exceeded budget')
})
