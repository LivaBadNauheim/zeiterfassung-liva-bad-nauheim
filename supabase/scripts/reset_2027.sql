-- ZURUECKSETZEN ZUM 01.01.2027 (Neuanmeldung des Unternehmens)
--
-- NICHT als Migration ausfuehren! Erst NACHDEM das Archiv (Excel + Vollsicherung)
-- heruntergeladen, geoeffnet/geprueft und auf zwei externen Speichern abgelegt ist.
--
-- Loescht: alle Zeiten, Dienstplan (Schichten, Verfuegbarkeiten, Interessen, Freigaben),
-- alle Mitarbeiterkonten inkl. Login – AUSSER dem Admin "Baris As".
-- Bleibt: Admin-Konto, Einstellungen (Frist, Frueh/Spaet-Zeiten), Bereiche Kueche/Service.
-- Staff-App (Reservierungen, Speisekarte) ist nicht betroffen.

-- ---------- Schritt 1: Vorschau (zuerst allein ausfuehren) ----------
-- Muss GENAU eine Zeile mit Baris As (admin) zeigen:
-- select id, full_name, role from public.profiles
--   where role = 'admin' and trim(lower(full_name)) like 'bar%s as';
--
-- Was geloescht wird:
-- select (select count(*) from public.time_entries) as zeiten,
--        (select count(*) from public.schichten) as schichten,
--        (select count(*) from public.profiles) - 1 as konten;

-- ---------- Schritt 2: Loeschen (alles markieren und ausfuehren) ----------
begin;

create temp table behalten on commit drop as
  select id from public.profiles
  where role = 'admin' and trim(lower(full_name)) like 'bar%s as';

do $$
begin
  if (select count(*) from behalten) <> 1 then
    raise exception 'Admin "Baris As" nicht eindeutig gefunden – nichts geloescht.';
  end if;
end $$;

delete from public.schicht_interessen;
delete from public.schichten;
delete from public.verfuegbarkeiten;
delete from public.dienstplan_wochen;
delete from public.time_entries;
delete from public.push_abos where user_id not in (select id from behalten);
delete from public.mitarbeiter_bereiche where user_id not in (select id from behalten);
delete from public.profiles where id not in (select id from behalten);
delete from auth.users where id not in (select id from behalten);

commit;

-- ---------- Schritt 3: Kontrolle ----------
-- select count(*) from public.profiles;      -- 1
-- select count(*) from auth.users;           -- 1
-- select count(*) from public.time_entries;  -- 0
