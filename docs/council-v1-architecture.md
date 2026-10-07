# Council v1 architecture

```text
Browser Council UI
  │ authenticated Supabase JWT
  ├──► Postgres + RLS + Realtime
  │
  └──► council-orchestrator Edge Function
            │
      ┌─────┼─────┐
      ▼     ▼     ▼
   OpenAI Claude Grok
      │     │     │
      └─────┼─────┘
            ▼
 contributions / agent_runs / decisions

GitHub ── HMAC webhook ──► github-webhook
                              │
                              ▼
                     github_events / github_refs
```

Council uses a common provider-neutral record so all three models see the same published proposals, critiques, evidence summaries, recommendations, and decisions.

Provider failure is isolated: a failed model run is recorded in `agent_runs` and other providers continue. GitHub delivery IDs are deduplicated in the database.
