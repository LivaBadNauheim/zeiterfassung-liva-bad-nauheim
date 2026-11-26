// Reine Funktionen fuer den Dienstplan (keine Datenbank, kein React).
// Werden im Browser (Vorschau) und auf dem Server (verbindliche Pruefung) genutzt.

export type SchichtZeit = {
  id?: string
  datum: string // YYYY-MM-DD
  beginn: string // HH:MM oder HH:MM:SS
  ende: string // ende <= beginn => ueber Mitternacht
}

export type Pruefung = {
  sperren: string[] // Zuweisung nicht erlaubt
  hinweise: string[] // erlaubt, aber anzeigen
}

const RUHEZEIT_MIN = 10 * 60 // § 5 ArbZG, Gastro-Verkuerzung
const TAGES_MAX_MIN = 10 * 60 // § 3 ArbZG

// ---------- Datum / Zeit ----------

export function zeitZuMinuten(zeit: string): number {
  const [h, m] = zeit.split(":").map(Number)
  return h * 60 + (m || 0)
}

export function datumZuTag(datum: string): number {
  const [y, m, d] = datum.split("-").map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / 86400000)
}

export function tagZuDatum(tag: number): string {
  return new Date(tag * 86400000).toISOString().slice(0, 10)
}

export function addTage(datum: string, tage: number): string {
  return tagZuDatum(datumZuTag(datum) + tage)
}

/** 1 = Montag ... 7 = Sonntag */
export function wochentag(datum: string): number {
  const d = new Date(datumZuTag(datum) * 86400000).getUTCDay()
  return d === 0 ? 7 : d
}

export function montagVon(datum: string): string {
  return addTage(datum, 1 - wochentag(datum))
}

/** Jetzt als Berliner Wandzeit, unabhaengig von Server-/Geraete-Zeitzone. */
export function berlinJetzt(jetzt: Date = new Date()): { datum: string; zeit: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(jetzt)
      .map((x) => [x.type, x.value])
  )
  return { datum: `${p.year}-${p.month}-${p.day}`, zeit: `${p.hour}:${p.minute}` }
}

/** Absolute Minuten (seit 1970, Wandzeit) – zum Vergleichen von Datum+Uhrzeit. */
export function absMinuten(datum: string, zeit: string): number {
  return datumZuTag(datum) * 1440 + zeitZuMinuten(zeit)
}

export function intervall(s: SchichtZeit): [number, number] {
  const start = absMinuten(s.datum, s.beginn)
  let ende = absMinuten(s.datum, s.ende)
  if (ende <= start) ende += 1440
  return [start, ende]
}

export function dauerMinuten(s: SchichtZeit): number {
  const [a, b] = intervall(s)
  return b - a
}

/** Gesetzliche Mindestpause (§ 4 ArbZG): >6 Std. 30 Min, >9 Std. 45 Min. */
export function mindestPause(minuten: number): number {
  if (minuten > 9 * 60) return 45
  if (minuten > 6 * 60) return 30
  return 0
}

export function arbeitsMinuten(s: SchichtZeit): number {
  const d = dauerMinuten(s)
  return d - mindestPause(d)
}

export function formatStunden(min: number): string {
  return `${(min / 60).toFixed(min % 60 === 0 ? 0 : 1).replace(".", ",")} Std.`
}

// ---------- Frist fuer Verfuegbarkeit ----------

export type FristEinstellung = { frist_wochentag: number; frist_uhrzeit: string }

/**
 * Frist fuer die Verfuegbarkeit der Woche `wocheStart` (Montag):
 * der eingestellte Wochentag in der Woche DAVOR.
 */
export function fristFuerWoche(wocheStart: string, e: FristEinstellung): { datum: string; zeit: string } {
  return { datum: addTage(wocheStart, -7 + e.frist_wochentag - 1), zeit: e.frist_uhrzeit.slice(0, 5) }
}

/** Die naechste Woche, fuer die man noch Verfuegbarkeit eintragen kann (Frist nicht abgelaufen). */
export function offeneVerfuegbarkeitsWoche(jetzt: { datum: string; zeit: string }, e: FristEinstellung): string {
  let woche = addTage(montagVon(jetzt.datum), 7)
  for (let i = 0; i < 3; i++) {
    const f = fristFuerWoche(woche, e)
    if (absMinuten(jetzt.datum, jetzt.zeit) < absMinuten(f.datum, f.zeit)) return woche
    woche = addTage(woche, 7)
  }
  return woche
}

// ---------- Zuweisung pruefen ----------

/**
 * Prueft, ob `neu` der Person zugewiesen werden darf.
 * @param andere alle anderen Schichten DERSELBEN Person (mind. Vortag bis Folgetag)
 * @param verfuegbar false = Person hat "nicht verfuegbar" eingetragen
 * @param grenze Stundengrenze; `bisherMin` = bereits geplante Minuten im Zeitraum
 */
export function pruefeZuweisung(
  neu: SchichtZeit,
  andere: SchichtZeit[],
  opts: { verfuegbar?: boolean | null; grenze?: { stunden: number; bisherMin: number; label: string } } = {}
): Pruefung {
  const sperren: string[] = []
  const hinweise: string[] = []
  const [nStart, nEnde] = intervall(neu)
  const rest = andere.filter((s) => !neu.id || s.id !== neu.id)

  if (opts.verfuegbar === false) sperren.push("Hat sich für diesen Tag als nicht verfügbar eingetragen.")

  for (const s of rest) {
    const [a, b] = intervall(s)
    if (a < nEnde && nStart < b) {
      sperren.push(`Überschneidung mit Schicht am ${s.datum} ${s.beginn.slice(0, 5)}–${s.ende.slice(0, 5)}.`)
      continue
    }
    if (s.datum === neu.datum) continue // geteilter Dienst am selben Tag
    const luecke = a >= nEnde ? a - nEnde : nStart - b
    if (luecke > 0 && luecke < RUHEZEIT_MIN) {
      sperren.push(`Ruhezeit nur ${formatStunden(luecke)} (mind. 10 Std.) zur Schicht am ${s.datum}.`)
    }
  }

  const tagMin = [neu, ...rest.filter((s) => s.datum === neu.datum)].reduce((sum, s) => sum + dauerMinuten(s), 0)
  const tagArbeit = tagMin - mindestPause(tagMin)
  if (tagArbeit > TAGES_MAX_MIN) hinweise.push(`Mehr als 10 Std. Arbeit an diesem Tag (${formatStunden(tagArbeit)}).`)

  if (opts.grenze && opts.grenze.stunden > 0) {
    const gesamt = opts.grenze.bisherMin + arbeitsMinuten(neu)
    if (gesamt > opts.grenze.stunden * 60) {
      hinweise.push(`${opts.grenze.label} überschritten: ${formatStunden(gesamt)} von ${opts.grenze.stunden} Std.`)
    }
  }

  return { sperren, hinweise }
}

// ---------- Frueh / Spaet ----------

export type SchichtZeitenEinstellung = {
  frueh_beginn?: string
  frueh_ende?: string
  spaet_beginn?: string
  spaet_ende?: string
  so_frueh_beginn?: string
  so_frueh_ende?: string
  so_spaet_beginn?: string
  so_spaet_ende?: string
}

/** Frueh-/Spaetschicht fuer einen Tag (Sonntag eigene Zeiten). */
export function schichtZeitenFuer(datum: string, e: SchichtZeitenEinstellung) {
  const so = wochentag(datum) === 7
  const z = (k: string, d: string) => ((e as Record<string, string | undefined>)[k] || d).slice(0, 5)
  return so
    ? { frueh: [z("so_frueh_beginn", "09:30"), z("so_frueh_ende", "16:00")], spaet: [z("so_spaet_beginn", "16:00"), z("so_spaet_ende", "22:00")] }
    : { frueh: [z("frueh_beginn", "08:30"), z("frueh_ende", "16:00")], spaet: [z("spaet_beginn", "16:00"), z("spaet_ende", "23:00")] }
}

export type VerfTag = { verfuegbar: boolean; frueh?: boolean | null; spaet?: boolean | null }

/**
 * Passt die Schicht zur eingetragenen Verfuegbarkeit?
 * null = nichts eingetragen. Alte Eintraege ohne frueh/spaet gelten fuer den ganzen Tag.
 * Eine Schicht braucht "frueh", wenn sie vor Beginn der Spaetschicht anfaengt,
 * und "spaet", wenn sie nach Ende der Fruehschicht aufhoert.
 */
export function passtVerfuegbarkeit(s: SchichtZeit, v: VerfTag | null | undefined, e: SchichtZeitenEinstellung): boolean | null {
  if (!v) return null
  if (!v.verfuegbar) return false
  if (v.frueh == null && v.spaet == null) return true
  const z = schichtZeitenFuer(s.datum, e)
  const start = zeitZuMinuten(s.beginn)
  const ende = start + dauerMinuten(s)
  const brauchtFrueh = start < zeitZuMinuten(z.spaet[0])
  const brauchtSpaet = ende > zeitZuMinuten(z.frueh[1])
  return (!brauchtFrueh || !!v.frueh) && (!brauchtSpaet || !!v.spaet)
}

export function verfText(v: VerfTag | null | undefined): string {
  if (!v) return "Frei"
  if (!v.verfuegbar) return "Kann nicht"
  if (v.frueh && v.spaet) return "Früh + Spät"
  if (v.frueh) return "Früh"
  if (v.spaet) return "Spät"
  return "Kann ✓"
}
