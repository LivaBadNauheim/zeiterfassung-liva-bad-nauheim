import * as XLSX from "xlsx"
import type { SupabaseClient } from "@supabase/supabase-js"
import { adminDb, benutzerAusRequest, Fehler, fehlerAntwort } from "@/lib/dienstplan/server"

// Archiv vor dem Zuruecksetzen.
//   GET ?format=xlsx  -> lesbare Excel fuer Pruefungen
//   GET ?format=json  -> Vollsicherung aller Tabellen (zum Wiederherstellen)
// Nur fuer Admins.

const TABELLEN = [
  "profiles",
  "time_entries",
  "schichten",
  "verfuegbarkeiten",
  "schicht_interessen",
  "dienstplan_wochen",
  "dienst_bereiche",
  "mitarbeiter_bereiche",
  "dienstplan_einstellungen",
]

type Zeile = Record<string, unknown>

/** Liest eine Tabelle vollstaendig (Supabase liefert max. 1000 Zeilen pro Abfrage). */
async function alle(db: SupabaseClient, tabelle: string): Promise<Zeile[]> {
  const out: Zeile[] = []
  for (let von = 0; ; von += 1000) {
    const { data, error } = await db.from(tabelle).select("*").range(von, von + 999)
    if (error) throw new Fehler(`${tabelle}: ${error.message}`, 500)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) return out
  }
}

function minuten(beginn: string | null, ende: string | null) {
  if (!beginn || !ende) return 0
  const a = Number(beginn.slice(0, 2)) * 60 + Number(beginn.slice(3, 5))
  let b = Number(ende.slice(0, 2)) * 60 + Number(ende.slice(3, 5))
  if (b <= a) b += 1440
  return b - a
}

const TYP: Record<string, string> = { work: "Arbeit", vacation: "Urlaub", sick: "Krank", day_off: "Frei", holiday: "Feiertag" }
const std = (min: number) => Math.round((min / 60) * 100) / 100
const dt = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`

export async function GET(req: Request) {
  try {
    const db = adminDb()
    const me = await benutzerAusRequest(req, db)
    if (me.role !== "admin") throw new Fehler("Keine Berechtigung.", 403)
    const format = new URL(req.url).searchParams.get("format") || "xlsx"
    const stempel = new Date().toISOString().slice(0, 10)

    const daten: Record<string, Zeile[]> = {}
    for (const t of TABELLEN) daten[t] = await alle(db, t)

    // Login-Adressen aus Auth (fuer die Vollsicherung)
    const nutzer: Zeile[] = []
    for (let page = 1; ; page++) {
      const { data } = await db.auth.admin.listUsers({ page, perPage: 1000 })
      for (const u of data?.users ?? []) nutzer.push({ id: u.id, email: u.email, created_at: u.created_at, last_sign_in_at: u.last_sign_in_at })
      if (!data || data.users.length < 1000) break
    }

    if (format === "json") {
      const body = JSON.stringify({ erstellt_am: new Date().toISOString(), erstellt_von: me.full_name, auth_users: nutzer, tabellen: daten }, null, 2)
      return new Response(body, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="liva-vollsicherung-${stempel}.json"`,
        },
      })
    }

    // ---------------- Excel
    const name = new Map(daten.profiles.map((p) => [p.id as string, (p.full_name as string) ?? ""]))
    const bereich = new Map(daten.dienst_bereiche.map((b) => [b.id as string, b.name as string]))
    const wb = XLSX.utils.book_new()
    const blatt = (titel: string, kopf: string[], zeilen: unknown[][]) => {
      const ws = XLSX.utils.aoa_to_sheet([kopf, ...zeilen])
      ws["!cols"] = kopf.map((k) => ({ wch: Math.max(12, k.length + 2) }))
      XLSX.utils.book_append_sheet(wb, ws, titel)
    }

    const zeiten = [...daten.time_entries].sort((a, b) =>
      `${name.get(a.user_id as string)}${a.work_date}`.localeCompare(`${name.get(b.user_id as string)}${b.work_date}`)
    )
    blatt(
      "Arbeitszeiten",
      ["Mitarbeiter", "Datum", "Typ", "Beginn", "Ende", "Pause (Min.)", "Arbeitszeit (Std.)", "Notiz"],
      zeiten.map((z) => {
        const roh = z.entry_type === "work" ? minuten(z.start_time as string, z.end_time as string) : 0
        return [
          name.get(z.user_id as string) ?? z.user_id,
          dt(z.work_date as string),
          TYP[z.entry_type as string] ?? z.entry_type,
          ((z.start_time as string) ?? "").slice(0, 5),
          ((z.end_time as string) ?? "").slice(0, 5),
          z.break_minutes ?? 0,
          std(Math.max(roh - Number(z.break_minutes ?? 0), 0)),
          z.note ?? "",
        ]
      })
    )

    // Monatssummen je Mitarbeiter
    const summen = new Map<string, { min: number; urlaub: number; krank: number; tage: number }>()
    for (const z of daten.time_entries) {
      const key = `${name.get(z.user_id as string) ?? z.user_id}|${(z.work_date as string).slice(0, 7)}`
      const s = summen.get(key) ?? { min: 0, urlaub: 0, krank: 0, tage: 0 }
      if (z.entry_type === "work") {
        s.min += Math.max(minuten(z.start_time as string, z.end_time as string) - Number(z.break_minutes ?? 0), 0)
        s.tage++
      }
      if (z.entry_type === "vacation") s.urlaub++
      if (z.entry_type === "sick") s.krank++
      summen.set(key, s)
    }
    blatt(
      "Monatssummen",
      ["Mitarbeiter", "Monat", "Arbeitstage", "Arbeitszeit (Std.)", "Urlaubstage", "Kranktage"],
      [...summen.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, s]) => {
          const [n, m] = k.split("|")
          return [n, `${m.slice(5, 7)}/${m.slice(0, 4)}`, s.tage, std(s.min), s.urlaub, s.krank]
        })
    )

    const mail = new Map(nutzer.map((u) => [u.id as string, u.email as string]))
    blatt(
      "Mitarbeiter",
      ["Name", "Login", "Rolle", "Aktiv", "Typ", "Stundengrenze"],
      [...daten.profiles]
        .sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)))
        .map((p) => [p.full_name, mail.get(p.id as string) ?? p.email ?? "", p.role, p.is_active ? "ja" : "nein", p.mitarbeiter_typ ?? "", p.stunden_grenze ?? 0])
    )

    blatt(
      "Dienstplan",
      ["Datum", "Beginn", "Ende", "Mitarbeiter", "Bereich", "Ausfall", "Notiz"],
      [...daten.schichten]
        .sort((a, b) => `${a.datum}${a.beginn}`.localeCompare(`${b.datum}${b.beginn}`))
        .map((s) => [
          dt(s.datum as string),
          (s.beginn as string).slice(0, 5),
          (s.ende as string).slice(0, 5),
          s.mitarbeiter_id ? name.get(s.mitarbeiter_id as string) : "unbesetzt",
          s.bereich_id ? bereich.get(s.bereich_id as string) : "",
          s.ausfall_grund === "krank" ? "Krank" : (s.ausfall_grund ?? ""),
          s.notiz ?? "",
        ])
    )

    blatt(
      "Verfügbarkeiten",
      ["Mitarbeiter", "Datum", "Früh", "Spät", "Verfügbar"],
      [...daten.verfuegbarkeiten]
        .sort((a, b) => `${name.get(a.user_id as string)}${a.datum}`.localeCompare(`${name.get(b.user_id as string)}${b.datum}`))
        .map((v) => [name.get(v.user_id as string), dt(v.datum as string), v.frueh ? "ja" : "", v.spaet ? "ja" : "", v.verfuegbar ? "ja" : "nein"])
    )

    blatt("Info", ["Feld", "Wert"], [
      ["Erstellt am", new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" })],
      ["Erstellt von", me.full_name],
      ["Zeiteinträge", daten.time_entries.length],
      ["Mitarbeiter", daten.profiles.length],
      ["Schichten", daten.schichten.length],
      ["Hinweis", "Arbeitszeit = Ende − Beginn − Pause. Vollständige Rohdaten in der Vollsicherung (JSON)."],
    ])

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" })
    return new Response(buf, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="liva-archiv-${stempel}.xlsx"`,
      },
    })
  } catch (e) {
    return fehlerAntwort(e)
  }
}
