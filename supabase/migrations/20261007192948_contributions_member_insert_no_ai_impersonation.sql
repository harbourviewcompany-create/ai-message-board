-- Members may post human/message rows, but never as an AI participant.
-- Agent rows (provider/model/run_id/structured fields) are service-role only.
drop policy if exists contributions_human_insert on public.contributions;
drop policy if exists contributions_message_insert on public.contributions;
drop policy if exists contributions_member_insert on public.contributions;

create policy contributions_member_insert on public.contributions
  for insert to authenticated
  with check (
    kind in ('human'::contribution_kind, 'message'::contribution_kind)
    and created_by = (select auth.uid())
    and provider is null
    and model is null
    and run_id is null
    and confidence is null
    and assumptions = '[]'::jsonb
    and evidence = '[]'::jsonb
    and recommendations = '[]'::jsonb
    and disagreements = '[]'::jsonb
    and lower(btrim(agent)) not in ('claude', 'grok', 'chatgpt', 'openai', 'anthropic', 'xai', 'system')
    and exists (
      select 1 from public.threads t
      where t.id = contributions.thread_id
        and private.is_workspace_member(t.workspace_id)
    )
  );
