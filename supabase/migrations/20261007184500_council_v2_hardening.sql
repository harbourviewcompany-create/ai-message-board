begin;

do $$ begin
  create type public.council_run_status as enum (
    'queued', 'running', 'awaiting_approval', 'complete', 'failed', 'cancelled'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.council_strategy as enum (
    'balanced', 'quality', 'fast', 'economy', 'adversarial'
  );
exception when duplicate_object then null;
end $$;

alter type public.thread_status add value if not exists 'awaiting_approval';

create table if not exists public.workspace_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  strategy public.council_strategy not null default 'balanced',
  require_human_approval boolean not null default true,
  enable_openai boolean not null default true,
  enable_anthropic boolean not null default true,
  enable_xai boolean not null default true,
  openai_model text not null default 'gpt-6.1-sol',
  openai_synthesis_model text not null default 'gpt-6-astra',
  anthropic_model text not null default 'claude-sonnet-5',
  xai_model text not null default 'grok-4.7',
  max_context_contributions integer not null default 30
    check (max_context_contributions between 6 and 100),
  provider_timeout_ms integer not null default 35000
    check (provider_timeout_ms between 5000 and 90000),
  max_retries integer not null default 1
    check (max_retries between 0 and 3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.workspace_settings (workspace_id)
select id from public.workspaces
on conflict (workspace_id) do nothing;

create table if not exists public.council_runs (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete restrict,
  idempotency_key text,
  status public.council_run_status not null default 'queued',
  strategy public.council_strategy not null default 'balanced',
  providers text[] not null default array['openai','anthropic','xai']::text[]
    check (
      cardinality(providers) between 1 and 3
      and providers <@ array['openai','anthropic','xai']::text[]
    ),
  current_phase text check (
    current_phase is null or current_phase in ('proposal','critique','synthesis','approval')
  ),
  error text,
  metrics jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metrics) = 'object'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists council_runs_thread_idempotency_idx
  on public.council_runs (thread_id, idempotency_key)
  where idempotency_key is not null;

create unique index if not exists council_runs_one_active_per_thread_idx
  on public.council_runs (thread_id)
  where status in ('queued', 'running');

create index if not exists council_runs_thread_created_idx
  on public.council_runs (thread_id, created_at desc);

create index if not exists council_runs_requested_by_idx
  on public.council_runs (requested_by);

alter table public.contributions
  add column if not exists run_id uuid references public.council_runs(id) on delete set null;

alter table public.agent_runs
  add column if not exists run_id uuid references public.council_runs(id) on delete set null;

alter table public.decisions
  add column if not exists run_id uuid references public.council_runs(id) on delete set null;

create index if not exists contributions_run_id_idx on public.contributions (run_id);
create index if not exists agent_runs_run_id_idx on public.agent_runs (run_id);
create index if not exists decisions_run_id_idx on public.decisions (run_id);

drop trigger if exists trg_workspace_settings_updated_at on public.workspace_settings;
create trigger trg_workspace_settings_updated_at
before update on public.workspace_settings
for each row execute function public.touch_updated_at();

drop trigger if exists trg_council_runs_updated_at on public.council_runs;
create trigger trg_council_runs_updated_at
before update on public.council_runs
for each row execute function public.touch_updated_at();

create or replace function private.add_workspace_owner_as_member()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.owner_id <> (select auth.uid()) then
    raise exception 'workspace owner must match authenticated user';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (workspace_id, user_id) do update set role = excluded.role;

  insert into public.workspace_settings (workspace_id)
  values (new.id)
  on conflict (workspace_id) do nothing;

  return new;
end;
$$;

revoke all on function private.add_workspace_owner_as_member()
from public, anon, authenticated;

create or replace function private.sync_decision_review_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if new.run_id is not null then
    if new.status = 'accepted' then
      update public.council_runs
      set status = 'complete',
          current_phase = 'approval',
          completed_at = coalesce(completed_at, now())
      where id = new.run_id;

      update public.threads
      set status = 'complete'
      where id = new.thread_id;
    elsif new.status = 'rejected' then
      update public.council_runs
      set status = 'complete',
          current_phase = 'approval',
          completed_at = coalesce(completed_at, now())
      where id = new.run_id;

      update public.threads
      set status = 'open'
      where id = new.thread_id;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.sync_decision_review_state()
from public, anon, authenticated;

drop trigger if exists trg_decisions_sync_review_state on public.decisions;
create trigger trg_decisions_sync_review_state
after update of status on public.decisions
for each row execute function private.sync_decision_review_state();

alter table public.workspace_settings enable row level security;
alter table public.council_runs enable row level security;

create policy workspace_settings_select on public.workspace_settings
for select to authenticated
using (private.is_workspace_member(workspace_id));

create policy workspace_settings_insert on public.workspace_settings
for insert to authenticated
with check (private.is_workspace_admin(workspace_id));

create policy workspace_settings_update on public.workspace_settings
for update to authenticated
using (private.is_workspace_admin(workspace_id))
with check (private.is_workspace_admin(workspace_id));

create policy council_runs_select on public.council_runs
for select to authenticated
using (
  exists (
    select 1 from public.threads t
    where t.id = council_runs.thread_id
      and private.is_workspace_member(t.workspace_id)
  )
);

drop policy if exists decisions_update on public.decisions;
create policy decisions_update on public.decisions
for update to authenticated
using (
  exists (
    select 1 from public.threads t
    where t.id = decisions.thread_id
      and private.is_workspace_admin(t.workspace_id)
  )
)
with check (
  exists (
    select 1 from public.threads t
    where t.id = decisions.thread_id
      and private.is_workspace_admin(t.workspace_id)
  )
);

do $$ begin
  alter publication supabase_realtime add table public.council_runs;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.workspace_settings;
exception when duplicate_object then null;
end $$;

commit;
