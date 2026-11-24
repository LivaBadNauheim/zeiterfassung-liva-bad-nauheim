-- Dienstplan-Modul (Schichten, Verfuegbarkeiten, Freigabe, Push-Benachrichtigungen).
--
-- WICHTIG: Wie 0001 manuell im Supabase SQL-Editor ausfuehren.
--
-- Zugriff: Alle Tabellen haben RLS aktiv und KEINE Policies. Gelesen und
-- geschrieben wird ausschliesslich ueber die API-Routen (app/api/dienstplan,
-- app/api/push, app/api/cron) mit dem Service-Role-Key. Diese pruefen Rolle
-- und Person serverseitig. So kann kein Mitarbeiter per Anon-Key fremde Daten
-- lesen (z.B. Krankmeldungen).

create table if not exists public.dienst_bereiche (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  farbe text not null default '#e88e36',
  sortierung int not null default 0
);

insert into public.dienst_bereiche (name, farbe, sortierung) values
  ('Küche', '#d97706', 1),
  ('Service', '#2563eb', 2)
on conflict (name) do nothing;

create table if not exists public.mitarbeiter_bereiche (
  user_id uuid not null references public.profiles(id) on delete cascade,
  bereich_id uuid not null references public.dienst_bereiche(id) on delete cascade,
  primary key (user_id, bereich_id)
);

create table if not exists public.schichten (
  id uuid primary key default gen_random_uuid(),
  datum date not null,
  beginn time not null,
  ende time not null,                  -- ende <= beginn heisst: ueber Mitternacht
  mitarbeiter_id uuid references public.profiles(id) on delete set null,
  bereich_id uuid references public.dienst_bereiche(id) on delete set null,
  notiz text,
  offen boolean not null default false, -- fuer Team sichtbar, "Ich koennte" moeglich
  offen_seit timestamptz,
  ausfall_grund text check (ausfall_grund in ('krank', 'sonstiges')),
  erinnert_am timestamptz,             -- Schicht-Erinnerung 24 Std. vorher verschickt
  created_at timestamptz not null default now(),
  constraint schicht_offen_ohne_person check (not offen or mitarbeiter_id is null)
);
create index if not exists schichten_datum_idx on public.schichten (datum);
create index if not exists schichten_mitarbeiter_idx on public.schichten (mitarbeiter_id, datum);

create table if not exists public.schicht_interessen (
  schicht_id uuid not null references public.schichten(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (schicht_id, user_id)
);

create table if not exists public.verfuegbarkeiten (
  user_id uuid not null references public.profiles(id) on delete cascade,
  datum date not null,
  verfuegbar boolean not null,
  notiz text,
  updated_at timestamptz not null default now(),
  primary key (user_id, datum)
);

-- Eine Zeile je Planungswoche (Montag). Merkt Freigabe und verschickte Erinnerungen,
-- damit der stuendliche Cron nichts doppelt verschickt.
create table if not exists public.dienstplan_wochen (
  woche_start date primary key check (extract(isodow from woche_start) = 1),
  freigegeben_am timestamptz,
  frist_erinnerung_am timestamptz,
  frist_abgelaufen_info_am timestamptz
);

-- Genau eine Zeile (id = 1).
create table if not exists public.dienstplan_einstellungen (
  id int primary key default 1 check (id = 1),
  -- Bis wann die Verfuegbarkeit fuer die KOMMENDE Woche eingereicht sein muss:
  -- Wochentag in der laufenden Woche (1 = Mo ... 7 = So) und Uhrzeit (Berlin).
  frist_wochentag int not null default 4 check (frist_wochentag between 1 and 7),
  frist_uhrzeit time not null default '18:00',
  -- Wie viele Stunden vor der Frist erinnert wird.
  erinnerung_stunden int not null default 24 check (erinnerung_stunden between 1 and 168),
  -- Schicht-Erinnerung an Mitarbeitende X Stunden vor Beginn (0 = aus).
  schicht_erinnerung_stunden int not null default 24 check (schicht_erinnerung_stunden between 0 and 168)
);
insert into public.dienstplan_einstellungen (id) values (1) on conflict (id) do nothing;

create table if not exists public.push_abos (
  endpoint text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_abos_user_idx on public.push_abos (user_id);

alter table public.dienst_bereiche enable row level security;
alter table public.mitarbeiter_bereiche enable row level security;
alter table public.schichten enable row level security;
alter table public.schicht_interessen enable row level security;
alter table public.verfuegbarkeiten enable row level security;
alter table public.dienstplan_wochen enable row level security;
alter table public.dienstplan_einstellungen enable row level security;
alter table public.push_abos enable row level security;
