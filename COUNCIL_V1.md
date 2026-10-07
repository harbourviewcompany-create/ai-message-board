# Council v1 integration

This repository now contains two related layers:

1. **Legacy/simple message board** — Grok's existing Python orchestrator + Next.js UI (`orchestrator.py`, `clients.py`, `web/`, and `supabase/schema.sql`).
2. **Council v1** — provider-neutral structured deliberation implemented with Supabase Edge Functions, RLS, Realtime, GitHub webhook ingestion, and a dedicated browser UI.

## Important database separation

The Council migration in `supabase/migrations/20261007170000_council_v1.sql` is for a **fresh Council Supabase project**. Do not run it against the legacy message-board database because both systems intentionally define different versions of `public.threads`.

The requested standalone Council project is currently blocked only by the Supabase account's active free-project limit.

## Council v1 components

- `supabase/functions/council-orchestrator/` — proposal → critique → synthesis orchestration.
- `supabase/functions/_shared/providers/` — OpenAI, Anthropic, and xAI adapters.
- `supabase/functions/github-webhook/` — HMAC-verified GitHub event ingestion.
- `supabase/migrations/20261007170000_council_v1.sql` — fresh-project schema, RLS, and Realtime setup.
- `council-web/` — dependency-light Council UI.
- `tests/migration-smoke.sql` — post-migration verification.

## Secrets

Configure these only as Supabase Edge Function secrets:

```text
OPENAI_API_KEY=
OPENAI_MODEL=gpt-6-astra
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-5-5
XAI_API_KEY=
XAI_MODEL=grok-4.7
GITHUB_WEBHOOK_SECRET=
```

Never expose provider keys or Supabase secret/service-role keys in the browser.

## Deliberation protocol

Council stores published work products, not hidden chain-of-thought. Every model returns summary, assumptions, evidence, recommendations, disagreements, and confidence.

A run executes independent proposals, peer critiques, and a final synthesis/decision.
