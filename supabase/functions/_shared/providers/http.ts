const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504])

function retryDelay(response: Response | null, attempt: number) {
  const header = response?.headers.get('retry-after')
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 5000)
  }
  return Math.min(500 * (2 ** attempt), 4000)
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxRetries: number,
): Promise<Response> {
  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response | null = null
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.ok || !RETRYABLE.has(response.status) || attempt === maxRetries) {
        return response
      }
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
      if (attempt === maxRetries) throw error
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)))
  }

  throw lastError instanceof Error ? lastError : new Error('Provider request failed')
}
