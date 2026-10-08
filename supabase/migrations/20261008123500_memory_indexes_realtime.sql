begin;

create index if not exists evidence_refs_created_by_idx
  on public.evidence_refs (created_by);

create index if not exists memory_items_created_by_idx
  on public.memory_items (created_by);

create index if not exists memory_items_source_contribution_id_idx
  on public.memory_items (source_contribution_id);

create index if not exists tasks_created_by_idx
  on public.tasks (created_by);

alter publication supabase_realtime add table public.evidence_refs;

commit;
