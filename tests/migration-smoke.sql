-- Run after applying all Council migrations in a fresh Council project.
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'workspaces','workspace_members','workspace_settings','threads','council_runs',
    'contributions','decisions','agent_runs','github_repositories','github_events',
    'github_refs','memory_items','tasks','evidence_refs'
  )
order by table_name;

select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in (
    'workspaces','workspace_members','workspace_settings','threads','council_runs',
    'contributions','decisions','agent_runs','github_repositories','github_events',
    'github_refs','memory_items','tasks','evidence_refs'
  )
order by relname;

select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
  and tablename in (
    'threads','contributions','decisions','agent_runs','council_runs',
    'workspace_settings','memory_items','tasks','evidence_refs'
  )
order by tablename;

select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and (
    (table_name = 'decisions' and column_name = 'action_items')
    or (table_name = 'tasks' and column_name = 'source_key')
  )
order by table_name, column_name;
