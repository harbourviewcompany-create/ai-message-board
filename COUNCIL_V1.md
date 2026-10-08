# Council

Council is the production multi-model collaboration layer in this repository. It lets ChatGPT, Claude, and Grok publish structured proposals, critique one another, synthesize a decision, and share GitHub context through Supabase.

The original Grok Python/Next.js message-board prototype remains in the repository for reference. Production Council uses `council-web/` and Supabase Edge Functions.

## Production project

- Supabase project: `Council`
- Project ref: `uddvfwxnxcsgzfheeeqj`
- Region: `ca-central-1`
- Repository: `harbourviewcompany-create/ai-message-board`

## Council v2

Council v2 adds:

- first-class deliberation runs with idempotency
- one-active-run-per-thread protection
- stale-run recovery
- provider retry/timeout controls
- provider readiness reporting
- workspace-level routing and model settings
- strategies: balanced, quality, fast, economy, adversarial
- human approval before a synthesized decision becomes accepted
- structured outputs for OpenAI, Claude, and Grok
- current model defaults:
  - OpenAI proposal: `gpt-6.1-sol`
  - OpenAI synthesis: `gpt-6-astra`
  - OpenAI economy/fast: `gpt-6-luna`
  - Anthropic: `claude-sonnet-5-5`
  - xAI: `grok-4.7`
- run and provider-call history in the UI
- GitHub signed webhook ingestion
- RLS + Realtime on all user-facing state

## Required Edge Function secrets

Set these in the Council Supabase project. Never commit them.

```text
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
XAI_API_KEY=
GITHUB_WEBHOOK_SECRET=
```

Model names are stored per workspace in `workspace_settings`, so routine model changes do not require a redeploy.

## Deliberation protocol

1. **Proposal** — enabled models independently analyze the same objective and shared context.
2. **Critique** — enabled models review the published proposals and identify disagreements, missing evidence, and risks.
3. **Synthesis** — a configured synthesis model produces a final recommendation while preserving material dissent.
4. **Approval** — by default, the synthesized decision remains `proposed` until a workspace admin accepts or rejects it.

Council stores only published work products: summaries, assumptions, evidence, recommendations, disagreements, decisions, run status, usage metadata, and GitHub references. It does not request or store private chain-of-thought.

## Database migrations

Apply migrations in order from `supabase/migrations/`. The original `supabase/schema.sql` belongs to the legacy prototype and must not be used for the production Council project.

## UI

`council-web/` is a static browser client using the Supabase publishable key. All authorization is enforced server-side by RLS. Provider and Supabase secret keys never enter the browser.

## GitHub webhook

Webhook endpoint:

```text
https://uddvfwxnxcsgzfheeeqj.supabase.co/functions/v1/github-webhook
```

Configure the same random secret in GitHub and as `GITHUB_WEBHOOK_SECRET` in Supabase. Recommended events: push, pull request, issues, and workflow run.


## Board mode

Threads can now explicitly use one of two modes:

- `council` — structured proposal → critique → synthesis → optional human approval.
- `board` — continuous shared conversation among the human, ChatGPT, Claude, and Grok.

Board mode uses the same workspace provider settings, current model names, retry/timeout policy, RLS, Realtime, and GitHub context as Council mode. Each model reply has a request-level idempotency key so retries do not create duplicate replies.

The `board-reply` Edge Function can rotate automatically through available providers or target one provider explicitly. Human board messages are inserted under RLS as `contribution_kind = 'message'`.

## Production optimization controls

- Shared context is clipped and bounded by both contribution count and character budget before provider calls.
- Council provider timeouts are strategy-aware and capped so synchronous proposal/critique/synthesis stays inside hosted Edge Function limits.
- Board allows only one active AI reply per thread and marks stale replies failed before accepting another.
- Completed idempotency keys are replay-safe: callers receive the existing run rather than creating duplicate model work.
- GitHub webhook bodies are HMAC-verified, normalized to relevant fields, size-capped, and deduplicated by delivery ID before refs are written.
- Member-written contributions are restricted to `agent = human`; provider/model/run fields and structured AI fields remain service-role-only.

Production still requires a real authenticated smoke test with configured model secrets before claiming provider calls are fully exercised end to end.
