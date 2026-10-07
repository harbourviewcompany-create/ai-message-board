-- Additive migration: support Board (continuous chat) mode
-- on top of Council v1 without breaking existing structured deliberation.
-- Safe to run after 20261007170000_council_v1.sql (+ index follow-up).

begin;

-- ---------------------------------------------------------------------------
-- 1. Thread mode: board (free-form) vs council (structured rounds)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'threads'
      and column_name = 'mode'
  ) then
    alter table public.threads
      add column mode text not null default 'board';
  end if;
end $$;

-- Backfill any nulls (defensive) then enforce the check
update public.threads set mode = 'board' where mode is null;

alter table public.threads
  drop constraint if exists threads_mode_check;

alter table public.threads
  add constraint threads_mode_check
  check (mode in ('board', 'council'));

comment on column public.threads.mode is
  'board = continuous free-form conversation; council = structured proposal/critique/synthesis';

-- ---------------------------------------------------------------------------
-- 2. Extend contribution_kind with free-form board messages
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'contribution_kind'
      and e.enumlabel = 'message'
  ) then
    alter type public.contribution_kind add value 'message';
  end if;
end $$;

-- Optional: also allow a simple system notice kind if you want it later
do $$
begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'contribution_kind'
      and e.enumlabel = 'system'
  ) then
    alter type public.contribution_kind add value 'system';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Convenience view for simple board / chat UIs
--    Flattens contributions into a message-board shaped result set.
-- ---------------------------------------------------------------------------
create or replace view public.board_messages
with (security_invoker = true)
as
select
  c.id,
  c.thread_id,
  t.workspace_id,
  t.mode as thread_mode,
  c.agent as sender,
  c.provider,
  c.model,
  c.kind,
  c.round,
  c.summary as content,
  c.assumptions,
  c.evidence,
  c.recommendations,
  c.disagreements,
  c.confidence,
  c.metadata,
  c.created_by,
  c.created_at
from public.contributions c
join public.threads t on t.id = c.thread_id
where c.kind in (
  'human',
  'message',
  'system',
  'proposal',
  'critique',
  'research',
  'synthesis',
  'decision_note',
  'github'
);

comment on view public.board_messages is
  'Flattened timeline for Board and Council UIs. RLS is enforced via underlying tables (security_invoker).';

-- ---------------------------------------------------------------------------
-- 4. Helpful indexes for board-style polling / realtime consumers
-- ---------------------------------------------------------------------------
create index if not exists contributions_thread_kind_created_idx
  on public.contributions (thread_id, kind, created_at);

create index if not exists threads_workspace_mode_updated_idx
  on public.threads (workspace_id, mode, updated_at desc);

-- ---------------------------------------------------------------------------
-- 5. RLS: allow authenticated members to insert free-form board messages
--    (Council agent writes continue to go through the service role /
--     Edge Function path.)
-- ---------------------------------------------------------------------------
drop policy if exists contributions_message_insert on public.contributions;

create policy contributions_message_insert
  on public.contributions
  for insert
  to authenticated
  with check (
    kind in ('human', 'message')
    and created_by = (select auth.uid())
    and exists (
      select 1
      from public.threads t
      where t.id = contributions.thread_id
        and private.is_workspace_member(t.workspace_id)
    )
  );

-- Keep the existing human-only policy for backward compatibility;
-- the new policy is additive and covers both human and message kinds.

-- ---------------------------------------------------------------------------
-- 6. Optional helper: set thread mode safely
-- ---------------------------------------------------------------------------
create or replace function public.set_thread_mode(target_thread uuid, new_mode text)
returns public.threads
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  updated public.threads;
begin
  if new_mode not in ('board', 'council') then
    raise exception 'mode must be board or council';
  end if;

  update public.threads t
  set mode = new_mode,
      updated_at = now()
  where t.id = target_thread
    and private.is_workspace_member(t.workspace_id)
  returning * into updated;

  if updated.id is null then
    raise exception 'thread not found or forbidden';
  end if;

  return updated;
end;
$$;

revoke all on function public.set_thread_mode(uuid, text) from public, anon;
grant execute on function public.set_thread_mode(uuid, text) to authenticated;

commit;
