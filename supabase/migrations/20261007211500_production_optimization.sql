begin;

alter table public.workspace_settings
  add column if not exists openai_economy_model text not null default 'gpt-6-luna',
  add column if not exists max_context_chars integer not null default 18000,
  add column if not exists board_stale_after_seconds integer not null default 300;

alter table public.workspace_settings
  alter column anthropic_model set default 'claude-sonnet-5-5',
  alter column provider_timeout_ms set default 30000,
  alter column max_retries set default 0,
  alter column max_context_contributions set default 18;

update public.workspace_settings
set anthropic_model = 'claude-sonnet-5-5'
where anthropic_model = 'claude-sonnet-5';

update public.workspace_settings
set openai_economy_model = 'gpt-6-luna'
where openai_economy_model is null or btrim(openai_economy_model) = '';

alter table public.workspace_settings
  drop constraint if exists workspace_settings_max_context_chars_check,
  drop constraint if exists workspace_settings_board_stale_after_seconds_check;

alter table public.workspace_settings
  add constraint workspace_settings_max_context_chars_check
    check (max_context_chars between 4000 and 80000),
  add constraint workspace_settings_board_stale_after_seconds_check
    check (board_stale_after_seconds between 60 and 1800);

drop policy if exists contributions_human_insert on public.contributions;
drop policy if exists contributions_message_insert on public.contributions;
drop policy if exists contributions_member_insert on public.contributions;

create policy contributions_member_insert
on public.contributions
for insert
to authenticated
with check (
  kind in ('human', 'message')
  and created_by = (select auth.uid())
  and provider is null
  and model is null
  and run_id is null
  and confidence is null
  and assumptions = '[]'::jsonb
  and evidence = '[]'::jsonb
  and recommendations = '[]'::jsonb
  and disagreements = '[]'::jsonb
  and lower(btrim(agent)) = 'human'
  and exists (
    select 1
    from public.threads t
    where t.id = contributions.thread_id
      and private.is_workspace_member(t.workspace_id)
  )
);

create unique index if not exists agent_runs_one_running_message_per_thread_idx
  on public.agent_runs (thread_id)
  where phase = 'message' and status = 'running';

commit;
