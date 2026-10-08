begin;

create table if not exists public.memory_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  thread_id uuid references public.threads(id) on delete set null,
  source_contribution_id uuid references public.contributions(id) on delete set null,
  source_decision_id uuid references public.decisions(id) on delete set null,
  kind text not null check (kind in ('fact','decision','rejected_approach','open_question','incident','note')),
  title text not null check (length(trim(title)) between 1 and 200),
  content text not null check (length(trim(content)) between 1 and 20000),
  status text not null default 'active' check (status in ('active','superseded','archived')),
  confidence numeric(4,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  thread_id uuid references public.threads(id) on delete set null,
  decision_id uuid references public.decisions(id) on delete set null,
  title text not null check (length(trim(title)) between 1 and 240),
  description text not null default '' check (length(description) <= 20000),
  status text not null default 'todo' check (status in ('todo','in_progress','blocked','done','cancelled')),
  priority smallint not null default 3 check (priority between 1 and 5),
  owner_type text not null default 'unassigned' check (owner_type in ('human','model','unassigned')),
  owner text,
  due_at timestamptz,
  github_url text,
  created_by uuid not null references auth.users(id) on delete restrict,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.evidence_refs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  thread_id uuid references public.threads(id) on delete set null,
  contribution_id uuid references public.contributions(id) on delete set null,
  decision_id uuid references public.decisions(id) on delete set null,
  memory_item_id uuid references public.memory_items(id) on delete set null,
  source_type text not null check (source_type in ('url','github','document','user','system')),
  title text,
  url text,
  repository_full_name text,
  sha text,
  path text,
  excerpt text check (excerpt is null or length(excerpt) <= 8000),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists memory_items_workspace_status_updated_idx
  on public.memory_items (workspace_id, status, updated_at desc);
create index if not exists memory_items_thread_updated_idx
  on public.memory_items (thread_id, updated_at desc);
create index if not exists memory_items_kind_idx
  on public.memory_items (workspace_id, kind, updated_at desc);
create unique index if not exists memory_items_source_decision_unique_idx
  on public.memory_items (source_decision_id)
  where source_decision_id is not null and kind = 'decision';

create index if not exists tasks_workspace_status_priority_idx
  on public.tasks (workspace_id, status, priority, updated_at desc);
create index if not exists tasks_thread_status_idx
  on public.tasks (thread_id, status, updated_at desc);
create index if not exists tasks_decision_id_idx
  on public.tasks (decision_id);

create index if not exists evidence_refs_workspace_created_idx
  on public.evidence_refs (workspace_id, created_at desc);
create index if not exists evidence_refs_thread_created_idx
  on public.evidence_refs (thread_id, created_at desc);
create index if not exists evidence_refs_contribution_id_idx
  on public.evidence_refs (contribution_id);
create index if not exists evidence_refs_decision_id_idx
  on public.evidence_refs (decision_id);
create index if not exists evidence_refs_memory_item_id_idx
  on public.evidence_refs (memory_item_id);

drop trigger if exists trg_memory_items_updated_at on public.memory_items;
create trigger trg_memory_items_updated_at
before update on public.memory_items
for each row execute function public.touch_updated_at();

drop trigger if exists trg_tasks_updated_at on public.tasks;
create trigger trg_tasks_updated_at
before update on public.tasks
for each row execute function public.touch_updated_at();

create or replace function private.capture_accepted_decision_memory()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  target_workspace uuid;
  actor uuid;
begin
  if new.status <> 'accepted' then
    return new;
  end if;

  if tg_op = 'UPDATE' and old.status = 'accepted' then
    return new;
  end if;

  select workspace_id, created_by
  into target_workspace, actor
  from public.threads
  where id = new.thread_id;

  actor := coalesce((select auth.uid()), actor);

  if target_workspace is null or actor is null then
    return new;
  end if;

  insert into public.memory_items (
    workspace_id,
    thread_id,
    source_decision_id,
    kind,
    title,
    content,
    status,
    created_by,
    metadata
  )
  values (
    target_workspace,
    new.thread_id,
    new.id,
    'decision',
    left(new.decision, 200),
    concat_ws(E'\n\n', new.decision, nullif(new.rationale, '')),
    'active',
    actor,
    jsonb_build_object(
      'captured_from_decision', true,
      'capture_mode', case when tg_op = 'INSERT' then 'automatic' else 'approval' end
    )
  )
  on conflict (source_decision_id) where source_decision_id is not null and kind = 'decision'
  do nothing;

  return new;
end;
$$;

revoke all on function private.capture_accepted_decision_memory()
from public, anon;
grant execute on function private.capture_accepted_decision_memory() to authenticated, service_role;

drop trigger if exists trg_decisions_capture_memory on public.decisions;
create trigger trg_decisions_capture_memory
after insert or update of status on public.decisions
for each row execute function private.capture_accepted_decision_memory();

create or replace function private.protect_workspace_provenance()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.workspace_id <> old.workspace_id or new.created_by <> old.created_by then
    raise exception 'workspace_id and created_by are immutable';
  end if;
  return new;
end;
$$;

revoke all on function private.protect_workspace_provenance()
from public, anon;
grant execute on function private.protect_workspace_provenance() to authenticated, service_role;

drop trigger if exists trg_memory_items_provenance on public.memory_items;
create trigger trg_memory_items_provenance
before update on public.memory_items
for each row execute function private.protect_workspace_provenance();

drop trigger if exists trg_tasks_provenance on public.tasks;
create trigger trg_tasks_provenance
before update on public.tasks
for each row execute function private.protect_workspace_provenance();

drop trigger if exists trg_evidence_refs_provenance on public.evidence_refs;
create trigger trg_evidence_refs_provenance
before update on public.evidence_refs
for each row execute function private.protect_workspace_provenance();

revoke all on public.memory_items, public.tasks, public.evidence_refs from anon;
grant select, insert, update, delete on public.memory_items, public.tasks, public.evidence_refs to authenticated;

alter table public.memory_items enable row level security;
alter table public.tasks enable row level security;
alter table public.evidence_refs enable row level security;

create policy memory_items_select on public.memory_items
for select to authenticated
using (private.is_workspace_member(workspace_id));

create policy memory_items_insert on public.memory_items
for insert to authenticated
with check (
  private.is_workspace_member(workspace_id)
  and created_by = (select auth.uid())
);

create policy memory_items_update on public.memory_items
for update to authenticated
using (private.is_workspace_member(workspace_id))
with check (private.is_workspace_member(workspace_id));

create policy memory_items_delete on public.memory_items
for delete to authenticated
using (private.is_workspace_admin(workspace_id));

create policy tasks_select on public.tasks
for select to authenticated
using (private.is_workspace_member(workspace_id));

create policy tasks_insert on public.tasks
for insert to authenticated
with check (
  private.is_workspace_member(workspace_id)
  and created_by = (select auth.uid())
);

create policy tasks_update on public.tasks
for update to authenticated
using (private.is_workspace_member(workspace_id))
with check (private.is_workspace_member(workspace_id));

create policy tasks_delete on public.tasks
for delete to authenticated
using (private.is_workspace_admin(workspace_id));

create policy evidence_refs_select on public.evidence_refs
for select to authenticated
using (private.is_workspace_member(workspace_id));

create policy evidence_refs_insert on public.evidence_refs
for insert to authenticated
with check (
  private.is_workspace_member(workspace_id)
  and created_by = (select auth.uid())
);

create policy evidence_refs_update on public.evidence_refs
for update to authenticated
using (private.is_workspace_member(workspace_id))
with check (private.is_workspace_member(workspace_id));

create policy evidence_refs_delete on public.evidence_refs
for delete to authenticated
using (private.is_workspace_admin(workspace_id));

do $$ begin
  alter publication supabase_realtime add table public.memory_items;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.tasks;
exception when duplicate_object then null;
end $$;

commit;
