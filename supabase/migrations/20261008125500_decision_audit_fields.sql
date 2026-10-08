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

commit;
