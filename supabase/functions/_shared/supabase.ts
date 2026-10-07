import { createClient } from 'npm:@supabase/supabase-js@2.117.1'

function firstKey(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed) {
      return parsed.default ?? Object.values(parsed).find((v) => typeof v === 'string') ?? null
    }
  } catch {
    return raw
  }
  return null
}

export function getRuntimeKeys() {
  const url = Deno.env.get('SUPABASE_URL')
  const publishable = firstKey(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')) ?? Deno.env.get('SUPABASE_ANON_KEY') ?? null
  const secret = firstKey(Deno.env.get('SUPABASE_SECRET_KEYS')) ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? null
  if (!url || !publishable || !secret) throw new Error('Supabase runtime keys are unavailable')
  return { url, publishable, secret }
}

export function userClient(authorization: string) {
  const { url, publishable } = getRuntimeKeys()
  return createClient(url, publishable, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export function serviceClient() {
  const { url, secret } = getRuntimeKeys()
  return createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
