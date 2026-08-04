-- Tracks per-user, per-day AI analysis call counts so the analyze-food Edge
-- Function can rate-limit and avoid a runaway Anthropic bill. Only the Edge
-- Function (via the service-role key) reads/writes this table, so no RLS
-- policies are needed beyond enabling RLS itself (locks out anon/authenticated).
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  count integer not null default 0,
  primary key (user_id, day)
);

alter table public.ai_usage enable row level security;
