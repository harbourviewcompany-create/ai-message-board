-- Run after applying the Council migration in a fresh Council project.
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'workspaces','workspace_members','threads','contributions','decisions',
    'agent_runs','github_repositories','github_events','github_refs'
  )
order by table_name;

select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in (
    'workspaces','workspace_members','threads','contributions','decisions',
    'agent_runs','github_repositories','github_events','github_refs'
  )
order by relname;

select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
  and tablename in ('threads','contributions','decisions','agent_runs')
order by tablename;
