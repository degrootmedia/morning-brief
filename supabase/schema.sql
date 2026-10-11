-- Morning Brief — Supabase schema
-- Run once in the Supabase dashboard: SQL Editor -> New query -> Run.
-- One synced row per user, protected by Row Level Security.

create table if not exists public.dashboards (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  state       jsonb not null default '{}'::jsonb,
  revision    bigint not null default 0,
  updated_at  timestamptz not null default now()
);

alter table public.dashboards enable row level security;

drop policy if exists "own row - select" on public.dashboards;
drop policy if exists "own row - insert" on public.dashboards;
drop policy if exists "own row - update" on public.dashboards;

create policy "own row - select" on public.dashboards
  for select using (auth.uid() = user_id);

create policy "own row - insert" on public.dashboards
  for insert with check (auth.uid() = user_id);

create policy "own row - update" on public.dashboards
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
