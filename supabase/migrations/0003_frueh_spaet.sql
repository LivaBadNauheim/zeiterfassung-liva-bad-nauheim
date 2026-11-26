-- Verfuegbarkeit je Tag als Frueh- und/oder Spaetschicht.
-- Im Supabase SQL-Editor ausfuehren. Bestehende Eintraege bleiben gueltig
-- (frueh/spaet leer = ganzer Tag wie bisher).

alter table public.verfuegbarkeiten
  add column if not exists frueh boolean,
  add column if not exists spaet boolean;

-- Schichtzeiten: Mo-Sa und Sonntag getrennt
alter table public.dienstplan_einstellungen
  add column if not exists frueh_beginn time not null default '08:30',
  add column if not exists frueh_ende time not null default '16:00',
  add column if not exists spaet_beginn time not null default '16:00',
  add column if not exists spaet_ende time not null default '23:00',
  add column if not exists so_frueh_beginn time not null default '09:30',
  add column if not exists so_frueh_ende time not null default '16:00',
  add column if not exists so_spaet_beginn time not null default '16:00',
  add column if not exists so_spaet_ende time not null default '22:00';
