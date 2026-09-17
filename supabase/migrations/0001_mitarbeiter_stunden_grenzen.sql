-- Mitarbeitertyp (Vollzeit/Teilzeit/Minijob) + Stundengrenze, Pausen-Automatik.
--
-- WICHTIG: Dieses Migrationsfile muss manuell gegen das Supabase-Projekt
-- ausgefuehrt werden (SQL-Editor oder `supabase db push`) -- dieses Repo hatte
-- bisher keinen supabase/migrations-Ordner und keine CI, die das automatisch
-- anwendet.
--
-- Nach dem Ausfuehren die Kontroll-Query ganz unten laufen lassen: sie zeigt
-- Namen aus der Liste, die in profiles NICHT gefunden wurden (z.B. wegen
-- abweichender Schreibweise) -- fuer die muss Typ/Stunden dann manuell in
-- "Mitarbeiter verwalten" nachgetragen werden.

alter table public.profiles
  add column if not exists mitarbeiter_typ text not null default 'vollzeit'
    check (mitarbeiter_typ in ('vollzeit', 'teilzeit', 'minijob')),
  add column if not exists stunden_grenze numeric(6,2) not null default 0
    check (stunden_grenze >= 0);

comment on column public.profiles.mitarbeiter_typ is
  'vollzeit/teilzeit -> stunden_grenze ist eine Wochengrenze; minijob -> stunden_grenze ist eine Monatsgrenze.';
comment on column public.profiles.stunden_grenze is
  '0 = keine Grenze.';

-- Datenpflege: bekannte Mitarbeiter mit ihren vereinbarten Stunden.
-- Abgleich ueber full_name (getrimmt, ohne Gross-/Kleinschreibung), nicht per
-- E-Mail, da Login-Adressen intern sind (vorname.nachname@zeiterfassung.local)
-- und nicht zwingend dem echten Namen folgen muessen.
with grenzen(name, typ, stunden) as (
  values
    ('Abdul K Al Khalil', 'vollzeit', 40),
    ('Aysel Özay', 'vollzeit', 40),
    ('Alp Aslan', 'vollzeit', 40),
    ('Gülay Akbulut', 'vollzeit', 40),
    ('Lukas Yong Friedel', 'vollzeit', 40),
    ('Rocco Luca Maiuolo', 'vollzeit', 34),
    ('Rosario Maiuolo', 'vollzeit', 35),
    ('Mert Gergin', 'vollzeit', 40),
    ('Alessia Gugliucci', 'minijob', 43),
    ('Anna Gugliucci', 'minijob', 43),
    ('Emma Kuhn', 'minijob', 43),
    ('Ertan Sen', 'minijob', 43),
    ('Eylül Aydin', 'minijob', 9),
    ('Karla Kempenich', 'minijob', 43),
    ('Lena Hampl', 'minijob', 43),
    ('Mert Otal', 'minijob', 43),
    ('Mio Sabina Riha', 'minijob', 43),
    ('Selenay Eraslan', 'minijob', 43),
    ('Sophie Hampl', 'minijob', 43),
    ('Thea Fischbach', 'minijob', 43),
    ('Lisa Marie Eisel', 'minijob', 43),
    ('Yadegül Yoldirim', 'minijob', 43)
)
update public.profiles p
set mitarbeiter_typ = g.typ,
    stunden_grenze = g.stunden
from grenzen g
where trim(lower(p.full_name)) = trim(lower(g.name));

-- Ab wann die neuen Regeln (Stundengrenze + Pausen-Automatik) gelten. Aeltere
-- bzw. laufende Eintragungen bleiben unangetastet, auch wenn sie nach diesem
-- Datum bearbeitet werden -- entscheidend ist work_date, nicht das
-- Bearbeitungsdatum. So gehen keine Daten verloren und die aktuelle
-- Eintragung wird nicht gestoert.
create or replace function public.zeit_gilt_ab()
returns date
language sql
immutable
as $$
  select date '2026-10-01'
$$;

-- Rohe Schichtdauer in Minuten, inkl. Mitternachtsueberlauf (z.B. 22:00-02:00 = 4h).
create or replace function public.zeit_rohminuten(v_start time, v_end time)
returns integer
language sql
immutable
as $$
  select case
    when extract(epoch from (v_end - v_start)) <= 0
      then (extract(epoch from (v_end - v_start)) / 60)::int + 24 * 60
    else (extract(epoch from (v_end - v_start)) / 60)::int
  end
$$;

-- Gearbeitete Minuten nach Abzug der Pause.
create or replace function public.zeit_arbeitsminuten(v_start time, v_end time, v_pause integer)
returns integer
language sql
immutable
as $$
  select greatest(public.zeit_rohminuten(v_start, v_end) - coalesce(v_pause, 0), 0)
$$;

create or replace function public.zeit_vor_speichern()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_raw_minutes integer;
  v_typ text;
  v_grenze numeric;
  v_rolle text;
  v_minuten_vorhanden integer;
  v_minuten_neu integer;
  v_periode_start date;
  v_periode_ende date;
begin
  if new.entry_type <> 'work' or new.start_time is null or new.end_time is null then
    return new;
  end if;

  if new.work_date < public.zeit_gilt_ab() then
    return new;
  end if;

  v_raw_minutes := public.zeit_rohminuten(new.start_time::time, new.end_time::time);

  -- Pausen-Automatik: ab mehr als 6 Stunden Schicht mindestens 30 Minuten
  -- Pause, egal was eingetragen wurde. Eine laengere manuell eingetragene
  -- Pause bleibt unangetastet.
  if v_raw_minutes > 360 and coalesce(new.break_minutes, 0) < 30 then
    new.break_minutes := 30;
  end if;

  select role, mitarbeiter_typ, stunden_grenze
    into v_rolle, v_typ, v_grenze
    from public.profiles
    where id = new.user_id;

  -- Die Leitung (Admin) ist von der Stundengrenze ausgenommen -- wer
  -- tatsaechlich laenger gearbeitet hat, muss das erfassen koennen.
  if v_rolle = 'admin' or v_grenze is null or v_grenze <= 0 then
    return new;
  end if;

  if v_typ = 'minijob' then
    -- Minijobber: Grenze pro Kalendermonat.
    v_periode_start := date_trunc('month', new.work_date)::date;
    v_periode_ende := (date_trunc('month', new.work_date) + interval '1 month' - interval '1 day')::date;
  else
    -- Vollzeit/Teilzeit: Grenze pro Kalenderwoche (Mo-So).
    v_periode_start := date_trunc('week', new.work_date)::date;
    v_periode_ende := v_periode_start + 6;
  end if;

  select coalesce(sum(public.zeit_arbeitsminuten(t.start_time::time, t.end_time::time, t.break_minutes)), 0)
    into v_minuten_vorhanden
    from public.time_entries t
    where t.user_id = new.user_id
      and t.entry_type = 'work'
      and t.work_date between v_periode_start and v_periode_ende
      and (new.id is null or t.id <> new.id);

  v_minuten_neu := public.zeit_arbeitsminuten(new.start_time::time, new.end_time::time, new.break_minutes);

  if v_minuten_vorhanden + v_minuten_neu > v_grenze * 60 then
    raise exception '% ueberschritten: % von % Stunden',
      (case when v_typ = 'minijob' then 'Monatsgrenze' else 'Wochengrenze' end),
      round((v_minuten_vorhanden + v_minuten_neu) / 60.0, 2),
      v_grenze
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists zeit_vor_speichern_pruefen on public.time_entries;
create trigger zeit_vor_speichern_pruefen
  before insert or update on public.time_entries
  for each row execute function public.zeit_vor_speichern();

-- Kontroll-Query (nach dem Ausfuehren separat starten, kein Teil der
-- Migration): zeigt Namen aus der obigen Liste, die in profiles nicht
-- gefunden wurden.
--
-- with grenzen(name) as (
--   values ('Abdul K Al Khalil'), ('Aysel Özay'), ('Alp Aslan'), ('Gülay Akbulut'),
--     ('Lukas Yong Friedel'), ('Rocco Luca Maiuolo'), ('Rosario Maiuolo'), ('Mert Gergin'),
--     ('Alessia Gugliucci'), ('Anna Gugliucci'), ('Emma Kuhn'), ('Ertan Sen'), ('Eylül Aydin'),
--     ('Karla Kempenich'), ('Lena Hampl'), ('Mert Otal'), ('Mio Sabina Riha'), ('Selenay Eraslan'),
--     ('Sophie Hampl'), ('Thea Fischbach'), ('Lisa Marie Eisel'), ('Yadegül Yoldirim')
-- )
-- select g.name
-- from grenzen g
-- where not exists (
--   select 1 from public.profiles p where trim(lower(p.full_name)) = trim(lower(g.name))
-- );
