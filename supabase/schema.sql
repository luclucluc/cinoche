-- Paris Ciné — comptes synchronisés (facultatifs)
-- À exécuter une fois dans Supabase : SQL Editor → New query → coller → Run.
--
-- Une ligne par compte : les préférences (thème, favoris, films vus, masquages, notes, cartes,
-- position…) au format JSON. Chaque personne ne peut lire et modifier que sa propre ligne.

create table if not exists public.preferences (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint preferences_taille check (pg_column_size(data) < 200000) -- garde-fou : 200 Ko max
);

alter table public.preferences enable row level security;

drop policy if exists "lire ses préférences" on public.preferences;
drop policy if exists "créer ses préférences" on public.preferences;
drop policy if exists "modifier ses préférences" on public.preferences;
drop policy if exists "supprimer ses préférences" on public.preferences;

create policy "lire ses préférences" on public.preferences
  for select using (auth.uid() = user_id);
create policy "créer ses préférences" on public.preferences
  for insert with check (auth.uid() = user_id);
create policy "modifier ses préférences" on public.preferences
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "supprimer ses préférences" on public.preferences
  for delete using (auth.uid() = user_id);

-- Suppression de son propre compte depuis le site (efface aussi ses préférences, par cascade)
create or replace function public.delete_me()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from auth.users where id = auth.uid();
$$;

revoke all on function public.delete_me() from public, anon;
grant execute on function public.delete_me() to authenticated;
