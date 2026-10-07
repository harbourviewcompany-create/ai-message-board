-- AI Message Board schema
-- Run this in the Supabase SQL Editor

-- Threads (conversations)
create table if not exists public.threads (
  id uuid primary key default gen_random_uuid(),
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Messages
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads(id) on delete cascade,
  sender text not null check (sender in ('human', 'grok', 'claude', 'gpt', 'system')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Helpful indexes
create index if not exists messages_thread_id_created_at_idx
  on public.messages (thread_id, created_at);

create index if not exists messages_sender_idx
  on public.messages (sender);

-- Auto-update thread.updated_at when a new message arrives
create or replace function public.set_thread_updated_at()
returns trigger
language plpgsql
as $$
begin
  update public.threads
  set updated_at = now()
  where id = new.thread_id;
  return new;
end;
$$;

drop trigger if exists messages_set_thread_updated_at on public.messages;
create trigger messages_set_thread_updated_at
  after insert on public.messages
  for each row
  execute function public.set_thread_updated_at();

-- Enable Realtime for the messages table
-- (In the dashboard you can also toggle Realtime on the table)
alter publication supabase_realtime add table public.messages;

-- Optional: simple RLS (service role bypasses this anyway)
alter table public.threads enable row level security;
alter table public.messages enable row level security;

-- Allow authenticated users to read (adjust for your needs)
create policy "Allow read access to threads"
  on public.threads for select
  using (true);

create policy "Allow read access to messages"
  on public.messages for select
  using (true);

-- For a private board you would tighten these policies and use auth.uid()
