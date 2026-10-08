import { routePhaseAdapters, strategyCallCeiling } from '../supabase/functions/_shared/providers/routing.ts'
import type { ProviderAdapter } from '../supabase/functions/_shared/providers/types.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function adapter(name: 'openai' | 'anthropic' | 'xai', configured = true): ProviderAdapter {
  return {
    name,
    model: name + '-test',
    configured,
    async run() { throw new Error('not called') },
  }
}

const all = [adapter('openai'), adapter('anthropic'), adapter('xai')]

Deno.test('economy uses one proposal, no critique, one synthesis', () => {
  assert(routePhaseAdapters(all, 'economy', 'proposal').length === 1, 'Economy proposal should use one provider')
  assert(routePhaseAdapters(all, 'economy', 'critique').length === 0, 'Economy should skip critique')
  assert(routePhaseAdapters(all, 'economy', 'synthesis').length === 1, 'Economy synthesis should use one provider')
  assert(strategyCallCeiling('economy', 3) === 2, 'Economy ceiling should be two calls')
})

Deno.test('fast uses up to two proposals, no critique, one synthesis', () => {
  assert(routePhaseAdapters(all, 'fast', 'proposal').length === 2, 'Fast proposal should use two providers')
  assert(routePhaseAdapters(all, 'fast', 'critique').length === 0, 'Fast should skip critique')
  assert(routePhaseAdapters(all, 'fast', 'synthesis').length === 1, 'Fast synthesis should use one provider')
  assert(strategyCallCeiling('fast', 3) === 3, 'Fast ceiling should be three calls')
})

Deno.test('balanced and quality preserve full multi-model review', () => {
  assert(routePhaseAdapters(all, 'balanced', 'proposal').length === 3, 'Balanced proposal lost providers')
  assert(routePhaseAdapters(all, 'balanced', 'critique').length === 3, 'Balanced critique lost providers')
  assert(strategyCallCeiling('balanced', 3) === 7, 'Balanced ceiling should be seven calls')
  assert(strategyCallCeiling('quality', 3) === 7, 'Quality ceiling should be seven calls')
})

Deno.test('routing ignores unavailable providers in reduced-cost modes', () => {
  const mixed = [adapter('openai', false), adapter('anthropic', true), adapter('xai', true)]
  const economy = routePhaseAdapters(mixed, 'economy', 'proposal')
  assert(economy.length === 1 && economy[0].name === 'anthropic', 'Economy did not fall back to configured provider')
})
