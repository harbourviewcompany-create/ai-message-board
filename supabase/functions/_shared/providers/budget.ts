import type { CouncilStrategy } from './types.ts'

function clamp(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

export function councilProviderBudget(settings: any, strategy: CouncilStrategy) {
  const requestedRetries = Math.trunc(clamp(settings.max_retries, 0, 1, 0))
  const requestedTimeout = clamp(settings.provider_timeout_ms, 5000, 90000, 30000)
  const strategyCeiling =
    strategy === 'fast' || strategy === 'economy' ? 15000
      : strategy === 'quality' || strategy === 'adversarial' ? 35000
      : 28000
  const timeoutMs = Math.min(requestedTimeout, requestedRetries > 0 ? 18000 : strategyCeiling)
  return { timeoutMs, maxRetries: requestedRetries }
}

export function boardProviderBudget(settings: any) {
  const maxRetries = Math.trunc(clamp(settings.max_retries, 0, 1, 0))
  const requestedTimeout = clamp(settings.provider_timeout_ms, 5000, 90000, 30000)
  const timeoutMs = Math.min(requestedTimeout, maxRetries > 0 ? 45000 : 60000)
  return { timeoutMs, maxRetries }
}
