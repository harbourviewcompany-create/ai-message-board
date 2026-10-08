begin;

alter table public.decisions
  add column if not exists confidence numeric(4,3),
  add column if not exists assumptions jsonb not null default '[]'::jsonb,
  add column if not exists evidence jsonb not null default '[]'::jsonb,
  add column if not exists disagreements jsonb not null default '[]'::jsonb;

alter table public.decisions
  drop constraint if exists decisions_confidence_check,
  drop constraint if exists decisions_assumptions_array_check,
  drop constraint if exists decisions_evidence_array_check,
  drop constraint if exists decisions_disagreements_array_check;

alter table public.decisions
  add constraint decisions_confidence_check
    check (confidence is null or (confidence >= 0 and confidence <= 1)),
  add constraint decisions_assumptions_array_check
    check (jsonb_typeof(assumptions) = 'array'),
  add constraint decisions_evidence_array_check
    check (jsonb_typeof(evidence) = 'array'),
  add constraint decisions_disagreements_array_check
    check (jsonb_typeof(disagreements) = 'array');

create or replace function private.capture_accepted_decision_memory()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $body$
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
    confidence,
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
    new.confidence,
    actor,
    jsonb_build_object(
      'captured_from_decision', true,
      'capture_mode', case when tg_op = 'INSERT' then 'automatic' else 'approval' end,
      'assumptions', new.assumptions,
      'evidence', new.evidence,
      'disagreements', new.disagreements
    )
  )
  on conflict (source_decision_id)
    where source_decision_id is not null and kind = 'decision'
  do update set
    content = excluded.content,
    confidence = excluded.confidence,
    metadata = excluded.metadata,
    updated_at = now();

  return new;
end;
$body$;

revoke all on function private.capture_accepted_decision_memory()
from public, anon;
grant execute on function private.capture_accepted_decision_memory()
to authenticated, service_role;

commit;
