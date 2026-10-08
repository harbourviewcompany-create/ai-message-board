begin;

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
  on conflict (source_decision_id)
    where source_decision_id is not null and kind = 'decision'
  do nothing;

  return new;
end;
$$;

commit;
