import { boardProviderBudget, councilProviderBudget } from '../supabase/functions/_shared/providers/budget.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

Deno.test('Council retries stay inside the free Edge Function wall-clock budget', () => {
  const budget = councilProviderBudget({ provider_timeout_ms: 90000, max_retries: 1 }, 'quality')
  assert(budget.timeoutMs <= 18000, 'Retry-enabled Council timeout is too large')
  assert(budget.maxRetries === 1, 'Retry count changed unexpectedly')
})

Deno.test('Fast Council strategy uses a short provider ceiling', () => {
  const budget = councilProviderBudget({ provider_timeout_ms: 90000, max_retries: 0 }, 'fast')
  assert(budget.timeoutMs <= 15000, 'Fast strategy timeout is too large')
})

Deno.test('Board provider calls remain bounded', () => {
  const budget = boardProviderBudget({ provider_timeout_ms: 90000, max_retries: 1 })
  assert(budget.timeoutMs <= 45000, 'Board retry timeout is too large')
})
