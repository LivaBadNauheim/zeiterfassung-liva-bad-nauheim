# Dienstplan – Einrichtung

## 1. Datenbank
`supabase/migrations/0002_dienstplan.sql` im Supabase SQL-Editor ausführen (wie 0001).

## 2. Push-Schlüssel (einmalig)
```bash
npx web-push generate-vapid-keys
```
In Vercel → Project → Settings → Environment Variables eintragen:

| Variable | Wert |
|---|---|
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Public Key |
| `VAPID_PRIVATE_KEY` | Private Key (geheim!) |
| `VAPID_SUBJECT` | `mailto:` + eine echte Kontaktadresse |
| `CRON_SECRET` | beliebiger langer Zufallswert |
| `SUPABASE_SERVICE_ROLE_KEY` | existiert schon |

Danach neu deployen.

## 3. Stündlicher Cron (Erinnerungen)
`vercel.json` ruft `/api/cron/dienstplan` stündlich auf – **das geht nur mit Vercel Pro**.
Bei Vercel Hobby stattdessen kostenlos über Supabase (SQL-Editor, Domain und Secret ersetzen):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('dienstplan-stuendlich', '5 * * * *', $$
  select net.http_get(
    url := 'https://DEINE-DOMAIN/api/cron/dienstplan',
    headers := jsonb_build_object('Authorization', 'Bearer DEIN_CRON_SECRET')
  );
$$);
```
(Dann den `crons`-Eintrag in `vercel.json` entfernen.)

## 4. Mitarbeitende: App + Push
- **iPhone (ab iOS 16.4):** Seite in Safari öffnen → Teilen → „Zum Home-Bildschirm“ → App von dort öffnen → einloggen → Dienstplan → „Aktivieren“. Push geht auf dem iPhone **nur** aus der installierten App.
- **Android:** In Chrome Menü ⋮ → „App installieren“ → Dienstplan → „Aktivieren“.
- Nach dem Aktivieren kommt sofort eine Test-Nachricht.

## Wer bekommt wann eine Benachrichtigung?
| Ereignis | Empfänger |
|---|---|
| X Std. vor Verfügbarkeits-Frist (Standard 24) | Mitarbeitende, die noch nichts eingetragen haben |
| Frist abgelaufen | Leitung: Liste, wer fehlt |
| Dienstplan freigegeben / erneut freigegeben | alle Mitarbeitenden, mit ihren eigenen Schichten |
| Schicht neu/geändert/gestrichen (nach Freigabe) | betroffene Person |
| Krankmeldung | Leitung (sofort) |
| Schicht zur Übernahme angeboten | Mitarbeitende des Bereichs |
| „Ich könnte“ | Leitung |
| Offene Schicht vergeben | gewählte Person + die anderen Interessenten |
| X Std. vor Schichtbeginn (Standard 24) | eingeteilte Person |

Frist, Erinnerungs-Vorlauf und Bereiche (Küche/Service) stellt der Admin unter Dienstplan → ⚙ Einstellungen ein.

## Tests
`npm test` prüft die Regeln (Überschneidung, 10 Std. Ruhezeit, >10 Std./Tag, Stundengrenze, Frist).
