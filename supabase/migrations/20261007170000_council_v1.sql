begin;

create extension if not exists pgcrypto;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

do $$ begin
  create type public.workspace_role as enum ('owner', 'admin', 'member', 'viewer');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.thread_status as enum ('open', 'running', 'complete', 'failed', 'archived');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.contribution_kind as enum ('human', 'proposal', 'critique', 'research', 'synthesis', 'decision_note', 'github');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.run_status as enum ('queued', 'running', 'complete', 'failed', 'skipped');
exception when duplicate_object then null;
end $$;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.workspace_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  title text not null check (length(trim(title)) between 1 and 200),
  objective text not null check (length(trim(objective)) between 1 and 20000),
  status public.thread_status not null default 'open',
  current_round integer not null default 0 check (current_round >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.contributions (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads(id) on delete cascade,
  parent_id uuid references public.contributions(id) on delete set null,
  agent text not null check (length(trim(agent)) between 1 and 80),
  provider text,
  model text,
  kind public.contribution_kind not null,
  round integer not null default 0 check (round >= 0),
  summary text not null check (length(trim(summary)) >= 1),
  assumptions jsonb not null default '[]'::jsonb check (jsonb_typeof(assumptions) = 'array'),
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  recommendations jsonb not null default '[]'::jsonb check (jsonb_typeof(recommendations) = 'array'),
  disagreements jsonb not null default '[]'::jsonb check (jsonb_typeof(disagreements) = 'array'),
  confidence numeric(4,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.decisions (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads(id) on delete cascade,
  decision text not null,
  rationale text,
  status text not null default 'proposed' check (status in ('proposed', 'accepted', 'rejected', 'superseded')),
  supporting_contributions uuid[] not null default '{}',
  dissenting_contributions uuid[] not null default '{}',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads(id) on delete cascade,
  contribution_id uuid references public.contributions(id) on delete set null,
  provider text not null,
  model text,
  phase text not null check (phase in ('proposal', 'critique', 'synthesis')),
  status public.run_status not null default 'queued',
  input_summary text,
  usage jsonb not null default '{}'::jsonb check (jsonb_typeof(usage) = 'object'),
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.github_repositories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  full_name text not null check (full_name ~ '^[^/[:space:]]+/[^/[:space:]]+$'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (workspace_id, full_name)
);

create unique index if not exists github_repositories_full_name_lower_idx
  on public.github_repositories (lower(full_name));

create table if not exists public.github_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  delivery_id text not null unique,
  event_name text not null,
  repository_full_name text,
  action text,
  actor text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  received_at timestamptz not null default now()
);

create table if not exists public.github_refs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  thread_id uuid references public.threads(id) on delete cascade,
  repository_full_name text not null,
  ref_type text not null check (ref_type in ('commit', 'branch', 'issue', 'pull_request', 'workflow', 'file')),
  ref_number text,
  sha text,
  path text,
  url text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists threads_workspace_created_idx on public.threads (workspace_id, created_at desc);
create index if not exists contributions_thread_created_idx on public.contributions (thread_id, created_at);
create index if not exists contributions_thread_round_idx on public.contributions (thread_id, round, kind);
create index if not exists agent_runs_thread_created_idx on public.agent_runs (thread_id, created_at desc);
create index if not exists github_events_workspace_received_idx on public.github_events (workspace_id, received_at desc);
create index if not exists github_refs_thread_idx on public.github_refs (thread_id, created_at desc);

create or replace function private.is_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.workspaces w
    where w.id = target_workspace
      and w.owner_id = (select auth.uid())
  ) or exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace
      and wm.user_id = (select auth.uid())
  );
$$;

revoke all on function private.is_workspace_member(uuid) from public, anon;
grant execute on function private.is_workspace_member(uuid) to authenticated;

create or replace function private.is_workspace_admin(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.workspaces w
    where w.id = target_workspace
      and w.owner_id = (select auth.uid())
  ) or exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace
      and wm.user_id = (select auth.uid())
      and wm.role in ('owner', 'admin')
  );
$$;

revoke all on function private.is_workspace_admin(uuid) from public, anon;
grant execute on function private.is_workspace_admin(uuid) to authenticated;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

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

  return new;
end;
$$;

revoke all on function private.add_workspace_owner_as_member() from public, anon, authenticated;

drop trigger if exists trg_workspaces_owner_member on public.workspaces;
create trigger trg_workspaces_owner_member
after insert on public.workspaces
for each row execute function private.add_workspace_owner_as_member();

drop trigger if exists trg_workspaces_updated_at on public.workspaces;
create trigger trg_workspaces_updated_at
before update on public.workspaces
for each row execute function public.touch_updated_at();

drop trigger if exists trg_threads_updated_at on public.threads;
create trigger trg_threads_updated_at
before update on public.threads
for each row execute function public.touch_updated_at();

drop trigger if exists trg_decisions_updated_at on public.decisions;
create trigger trg_decisions_updated_at
before update on public.decisions
for each row execute function public.touch_updated_at();

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.threads enable row level security;
alter table public.contributions enable row level security;
alter table public.decisions enable row level security;
alter table public.agent_runs enable row level security;
alter table public.github_repositories enable row level security;
alter table public.github_events enable row level security;
alter table public.github_refs enable row level security;

create policy workspaces_select on public.workspaces
for select to authenticated
using (private.is_workspace_member(id));

create policy workspaces_insert on public.workspaces
for insert to authenticated
with check (owner_id = (select auth.uid()));

create policy workspaces_update on public.workspaces
for update to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy workspaces_delete on public.workspaces
for delete to authenticated
using (owner_id = (select auth.uid()));

create policy workspace_members_select on public.workspace_members
for select to authenticated
using (private.is_workspace_member(workspace_id));

create policy workspace_members_insert on public.workspace_members
for insert to authenticated
with check (private.is_workspace_admin(workspace_id));

create policy workspace_members_update on public.workspace_members
for update to authenticated
using (private.is_workspace_admin(workspace_id))
with check (private.is_workspace_admin(workspace_id));

create policy workspace_members_delete on public.workspace_members
for delete to authenticated
using (private.is_workspace_admin(workspace_id));

create policy threads_select on public.threads
for select to authenticated
using (private.is_workspace_member(workspace_id));

create policy threads_insert on public.threads
for insert to authenticated
with check (
  private.is_workspace_member(workspace_id)
  and created_by = (select auth.uid())
);

create policy threads_update on public.threads
for update to authenticated
using (private.is_workspace_member(workspace_id))
with check (private.is_workspace_member(workspace_id));

create policy threads_delete on public.threads
for delete to authenticated
using (private.is_workspace_admin(workspace_id));

create policy contributions_select on public.contributions
for select to authenticated
using (
  exists (
    select 1 from public.threads t
    where t.id = contributions.thread_id
      and private.is_workspace_member(t.workspace_id)
  )
);

create policy contributions_human_insert on public.contributions
for insert to authenticated
with check (
  agent = 'human'
  and kind = 'human'
  and created_by = (select auth.uid())
  and exists (
    select 1 from public.threads t
    where t.id = contributions.thread_id
      and private.is_workspace_member(t.workspace_id)
  )
);

create policy decisions_select on public.decisions
for select to authenticated
using (
  exists (
    select 1 from public.threads t
    where t.id = decisions.thread_id
      and private.is_workspace_member(t.workspace_id)
  )
);

create policy decisions_update on public.decisions
for update to authenticated
using (
  exists (
    select 1 from public.threads t
    where t.id = decisions.thread_id
      and private.is_workspace_member(t.workspace_id)
  )
)
with check (
  exists (
    select 1 from public.threads t
    where t.id = decisions.thread_id
      and private.is_workspace_member(t.workspace_id)
  )
);

create policy agent_runs_select on public.agent_runs
for select to authenticated
using (
  exists (
    select 1 from public.threads t
    where t.id = agent_runs.thread_id
      and private.is_workspace_member(t.workspace_id)
  )
);

create policy github_repositories_select on public.github_repositories
for select to authenticated
using (private.is_workspace_member(workspace_id));

create policy github_repositories_insert on public.github_repositories
for insert to authenticated
with check (
  private.is_workspace_admin(workspace_id)
  and created_by = (select auth.uid())
);

create policy github_repositories_update on public.github_repositories
for update to authenticated
using (private.is_workspace_admin(workspace_id))
with check (private.is_workspace_admin(workspace_id));

create policy github_repositories_delete on public.github_repositories
for delete to authenticated
using (private.is_workspace_admin(workspace_id));

create policy github_events_select on public.github_events
for select to authenticated
using (workspace_id is not null and private.is_workspace_member(workspace_id));

create policy github_refs_select on public.github_refs
for select to authenticated
using (private.is_workspace_member(workspace_id));

do $$ begin
  alter publication supabase_realtime add table public.threads;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.contributions;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.decisions;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.agent_runs;
exception when duplicate_object then null;
end $$;

commit;
