-- Commit enum values separately so later migrations can safely reference them.
do $$
begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'contribution_kind'
      and e.enumlabel = 'message'
  ) then
    alter type public.contribution_kind add value 'message';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'contribution_kind'
      and e.enumlabel = 'system'
  ) then
    alter type public.contribution_kind add value 'system';
  end if;
end $$;
