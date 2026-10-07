begin;

alter table public.threads
  add column if not exists mode text not null default 'council';

update public.threads set mode = 'council' where mode is null;

alter table public.threads
  drop constraint if exists threads_mode_check;

alter table public.threads
  add constraint threads_mode_check
  check (mode in ('board', 'council'));

comment on column public.threads.mode is
  'board = continuous free-form conversation; council = structured proposal/critique/synthesis';

alter table public.agent_runs
  add column if not exists request_key text;

alter table public.agent_runs
  drop constraint if exists agent_runs_phase_check;

alter table public.agent_runs
  add constraint agent_runs_phase_check
  check (phase in ('proposal', 'critique', 'synthesis', 'message'));

create unique index if not exists agent_runs_thread_request_key_idx
  on public.agent_runs (thread_id, request_key)
  where request_key is not null;

create or replace view public.board_messages
with (security_invoker = true)
as
select
  c.id,
  c.thread_id,
  c.run_id,
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
  'human', 'message', 'system', 'proposal', 'critique',
  'research', 'synthesis', 'decision_note', 'github'
);

revoke all on public.board_messages from anon;
grant select on public.board_messages to authenticated;

create index if not exists contributions_thread_kind_created_idx
  on public.contributions (thread_id, kind, created_at);

create index if not exists threads_workspace_mode_updated_idx
  on public.threads (workspace_id, mode, updated_at desc);

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

create or replace function private.touch_thread_from_contribution()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  update public.threads
  set updated_at = now()
  where id = new.thread_id;
  return new;
end;
$$;

revoke all on function private.touch_thread_from_contribution()
from public, anon, authenticated;

drop trigger if exists trg_contributions_touch_thread on public.contributions;
create trigger trg_contributions_touch_thread
after insert on public.contributions
for each row execute function private.touch_thread_from_contribution();

commit;
