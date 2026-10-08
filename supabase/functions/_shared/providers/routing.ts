import type { CouncilStrategy, Phase, ProviderAdapter } from './types.ts'

export function routePhaseAdapters(
  adapters: ProviderAdapter[],
  strategy: CouncilStrategy,
  phase: Phase,
): ProviderAdapter[] {
  if (strategy !== 'economy' && strategy !== 'fast') return adapters

  const configured = adapters.filter((adapter) => adapter.configured)
  if (!configured.length) return []

  if (phase === 'critique') return []

  if (strategy === 'economy') {
    return [configured[0]]
  }

  if (phase === 'proposal') {
    return configured.slice(0, 2)
  }

  return [configured[0]]
}

export function strategyCallCeiling(strategy: CouncilStrategy, configuredProviders: number): number {
  const providers = Math.max(0, configuredProviders)
  if (strategy === 'economy') return providers > 0 ? 2 : 0
  if (strategy === 'fast') return Math.min(2, providers) + (providers > 0 ? 1 : 0)
  return (providers * 2) + (providers > 0 ? 1 : 0)
}
