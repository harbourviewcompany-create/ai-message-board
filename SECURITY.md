# Security

- Do not commit OpenAI, Anthropic, xAI, Supabase secret/service-role, or GitHub webhook secrets.
- The browser uses only a Supabase project URL and publishable key; authorization is enforced by RLS.
- `github-webhook` has JWT verification disabled because GitHub cannot provide a Supabase JWT. HMAC SHA-256 verification is therefore mandatory.
- The orchestrator first performs an RLS-bound thread read using the caller's JWT before privileged internal writes.
- Council stores concise published reasoning summaries and decisions, not hidden chain-of-thought.
- Grok's legacy `supabase/schema.sql` is a prototype schema and should not be confused with the Council v1 production migration.
- Authenticated members can only insert human/message contributions as `agent = human`; AI identity fields are reserved for server-side writes.
- GitHub webhook payloads are size-limited and normalized before persistence; duplicate delivery IDs return without producing duplicate refs.
- Enable Supabase Auth leaked-password protection for the production Council project; the security advisor currently flags it when disabled.
