begin;

alter table public.decisions
  add column if not exists action_items jsonb not null default '[]'::jsonb
    check (jsonb_typeof(action_items) = 'array');

alter table public.tasks
  add column if not exists source_key text;

create unique index if not exists tasks_decision_source_key_unique_idx
  on public.tasks (decision_id, source_key)
  where decision_id is not null and source_key is not null;

create or replace function private.create_tasks_from_accepted_decision()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $body$
declare
  target_workspace uuid;
  actor uuid;
  action_text text;
  action_number bigint;
begin
  if new.status <> 'accepted' then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if old.status = 'accepted' then
      return new;
    end if;
  end if;

  select workspace_id, created_by
  into target_workspace, actor
  from public.threads
  where id = new.thread_id;

  actor := coalesce((select auth.uid()), actor);

  if target_workspace is null or actor is null then
    return new;
  end if;

  for action_text, action_number in
    select trim(value), ordinality
    from jsonb_array_elements_text(new.action_items) with ordinality
    where length(trim(value)) > 0
  loop
    insert into public.tasks (
      workspace_id,
      thread_id,
      decision_id,
      title,
      description,
      status,
      priority,
      owner_type,
      source_key,
      created_by
    )
    values (
      target_workspace,
      new.thread_id,
      new.id,
      left(action_text, 240),
      action_text,
      'todo',
      3,
      'unassigned',
      'decision-action:' || action_number::text,
      actor
    )
    on conflict (decision_id, source_key)
      where decision_id is not null and source_key is not null
    do nothing;
  end loop;

  return new;
end;
$body$;

revoke all on function private.create_tasks_from_accepted_decision()
from public, anon;
grant execute on function private.create_tasks_from_accepted_decision()
to authenticated, service_role;

drop trigger if exists trg_decisions_create_tasks on public.decisions;
create trigger trg_decisions_create_tasks
after insert or update of status on public.decisions
for each row execute function private.create_tasks_from_accepted_decision();

commit;
