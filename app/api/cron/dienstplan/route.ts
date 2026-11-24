import { adminDb, adminIds, datumKurz, mitarbeiterIds, pushAn } from "@/lib/dienstplan/server"
import { absMinuten, addTage, berlinJetzt, fristFuerWoche, offeneVerfuegbarkeitsWoche } from "@/lib/dienstplan/regeln"

// Laeuft stuendlich (vercel.json oder Supabase pg_cron, siehe README-DIENSTPLAN.md).
// Jede Erinnerung wird in der DB vermerkt, mehrfaches Aufrufen ist also unschaedlich.
//  1. X Std. vor der Verfuegbarkeits-Frist: Erinnerung an alle, die noch nichts eingetragen haben
//  2. Frist abgelaufen: Info an die Leitung, wer fehlt
//  3. X Std. vor Schichtbeginn: Erinnerung an die eingeteilte Person (nur freigegebene Wochen)
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ success: false }, { status: 401 })
  }
  const db = adminDb()
  const jetzt = berlinJetzt()
  const jetztMin = absMinuten(jetzt.datum, jetzt.zeit)
  const { data: e } = await db.from("dienstplan_einstellungen").select("*").eq("id", 1).single()
  if (!e) return Response.json({ success: false, error: "Einstellungen fehlen" }, { status: 500 })
  const log: string[] = []

  // ---- 1. Frist-Erinnerung
  const woche = offeneVerfuegbarkeitsWoche(jetzt, e)
  const frist = fristFuerWoche(woche, e)
  const fristMin = absMinuten(frist.datum, frist.zeit)
  const { data: w } = await db.from("dienstplan_wochen").select("*").eq("woche_start", woche).maybeSingle()
  if (!w?.frist_erinnerung_am && jetztMin >= fristMin - e.erinnerung_stunden * 60) {
    const fehlend = await ohneVerfuegbarkeit(db, woche)
    await pushAn(db, fehlend, {
      title: "Verfügbarkeit eintragen ⏰",
      body: `Bitte trag bis ${datumKurz(frist.datum)} ${frist.zeit} Uhr ein, wann du in der Woche ab ${datumKurz(woche)} kannst.`,
      tag: `frist-${woche}`,
    })
    await db.from("dienstplan_wochen").upsert({ woche_start: woche, frist_erinnerung_am: new Date().toISOString() })
    log.push(`Frist-Erinnerung an ${fehlend.length}`)
  }

  // ---- 2. Frist der Vorwoche abgelaufen -> Leitung informieren
  const letzte = addTage(woche, -7)
  const { data: wl } = await db.from("dienstplan_wochen").select("*").eq("woche_start", letzte).maybeSingle()
  const letzteFrist = fristFuerWoche(letzte, e)
  if (!wl?.frist_abgelaufen_info_am && jetztMin >= absMinuten(letzteFrist.datum, letzteFrist.zeit) && jetzt.datum < letzte) {
    const fehlend = await ohneVerfuegbarkeit(db, letzte)
    let namen = ""
    if (fehlend.length) {
      const { data: p } = await db.from("profiles").select("full_name").in("id", fehlend)
      namen = (p ?? []).map((x) => x.full_name).join(", ")
    }
    await pushAn(db, await adminIds(db), {
      title: `Verfügbarkeiten Woche ab ${datumKurz(letzte)}`,
      body: fehlend.length ? `Frist vorbei. Es fehlen ${fehlend.length}: ${namen}` : "Frist vorbei – alle haben eingetragen ✔",
      tag: `frist-ende-${letzte}`,
    })
    await db.from("dienstplan_wochen").upsert({ woche_start: letzte, frist_abgelaufen_info_am: new Date().toISOString() })
    log.push(`Frist-Info Leitung (${fehlend.length} fehlen)`)
  }

  // ---- 3. Schicht-Erinnerung
  if (e.schicht_erinnerung_stunden > 0) {
    const grenzeMin = jetztMin + e.schicht_erinnerung_stunden * 60
    const { data: schichten } = await db
      .from("schichten")
      .select("id,datum,beginn,ende,mitarbeiter_id")
      .is("erinnert_am", null)
      .not("mitarbeiter_id", "is", null)
      .gte("datum", jetzt.datum)
      .lte("datum", addTage(jetzt.datum, 8))
    const { data: frei } = await db.from("dienstplan_wochen").select("woche_start").not("freigegeben_am", "is", null)
    const freigegeben = new Set((frei ?? []).map((x) => x.woche_start))
    for (const s of schichten ?? []) {
      const start = absMinuten(s.datum, s.beginn)
      if (start <= jetztMin || start > grenzeMin) continue
      const [y, m, d] = s.datum.split("-").map(Number)
      const wt = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7
      if (!freigegeben.has(addTage(s.datum, 1 - wt))) continue
      await pushAn(db, [s.mitarbeiter_id], {
        title: "Erinnerung: Schicht",
        body: `${datumKurz(s.datum)} ${s.beginn.slice(0, 5)}–${s.ende.slice(0, 5)}`,
        tag: `erinnerung-${s.id}`,
      })
      await db.from("schichten").update({ erinnert_am: new Date().toISOString() }).eq("id", s.id)
      log.push(`Schicht-Erinnerung ${s.id}`)
    }
  }

  return Response.json({ success: true, jetzt, log })
}

async function ohneVerfuegbarkeit(db: ReturnType<typeof adminDb>, woche: string) {
  const alle = await mitarbeiterIds(db)
  const { data } = await db.from("verfuegbarkeiten").select("user_id").gte("datum", woche).lte("datum", addTage(woche, 6))
  const mit = new Set((data ?? []).map((v) => v.user_id))
  return alle.filter((id) => !mit.has(id))
}
