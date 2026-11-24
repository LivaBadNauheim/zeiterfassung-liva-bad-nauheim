/* eslint-disable @typescript-eslint/no-explicit-any -- Request-Bodies werden je Aktion validiert */
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  adminDb,
  adminIds,
  benutzerAusRequest,
  datumKurz,
  Fehler,
  fehlerAntwort,
  mitarbeiterIds,
  pushAn,
  type Benutzer,
} from "@/lib/dienstplan/server"
import {
  addTage,
  arbeitsMinuten,
  berlinJetzt,
  fristFuerWoche,
  montagVon,
  offeneVerfuegbarkeitsWoche,
  pruefeZuweisung,
  type SchichtZeit,
} from "@/lib/dienstplan/regeln"

type Schicht = SchichtZeit & {
  id: string
  mitarbeiter_id: string | null
  bereich_id: string | null
  notiz: string | null
  offen: boolean
  offen_seit: string | null
  ausfall_grund: string | null
}

const SCHICHT_FELDER = "id,datum,beginn,ende,mitarbeiter_id,bereich_id,notiz,offen,offen_seit,ausfall_grund"
const DATUM = /^\d{4}-\d{2}-\d{2}$/
const ZEIT = /^\d{2}:\d{2}(:\d{2})?$/

function kw(datum: string) {
  const d = new Date(datum + "T00:00:00Z")
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const jahrStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - jahrStart.getTime()) / 86400000 + 1) / 7)
}

async function einstellungen(db: SupabaseClient) {
  const { data } = await db.from("dienstplan_einstellungen").select("*").eq("id", 1).single()
  return data ?? { frist_wochentag: 4, frist_uhrzeit: "18:00", erinnerung_stunden: 24, schicht_erinnerung_stunden: 24 }
}

async function istFreigegeben(db: SupabaseClient, datum: string) {
  const { data } = await db.from("dienstplan_wochen").select("freigegeben_am").eq("woche_start", montagVon(datum)).maybeSingle()
  return !!data?.freigegeben_am
}

function zeitText(s: SchichtZeit) {
  return `${datumKurz(s.datum)} ${s.beginn.slice(0, 5)}–${s.ende.slice(0, 5)}`
}

// ---------------------------------------------------------------- GET

export async function GET(req: Request) {
  try {
    const db = adminDb()
    const me = await benutzerAusRequest(req, db)
    const url = new URL(req.url)
    const heute = berlinJetzt().datum
    const e = await einstellungen(db)
    const { data: bereiche } = await db.from("dienst_bereiche").select("*").order("sortierung")

    if (me.role === "admin") {
      const woche = montagVon(url.searchParams.get("woche") || heute)
      const bis = addTage(woche, 6)
      const [profile, zuordnung, schichten, verf, wocheRow, offene] = await Promise.all([
        db.from("profiles").select("id,full_name,role,mitarbeiter_typ,stunden_grenze").eq("is_active", true).order("full_name"),
        db.from("mitarbeiter_bereiche").select("user_id,bereich_id"),
        // Vortag/Folgetag fuer Ruhezeit-Pruefung, Monat fuer Minijob-Grenze
        db.from("schichten").select(SCHICHT_FELDER).gte("datum", addTage(woche.slice(0, 8) + "01", -1)).lte("datum", addTage(bis, 31)),
        db.from("verfuegbarkeiten").select("user_id,datum,verfuegbar,notiz").gte("datum", woche).lte("datum", bis),
        db.from("dienstplan_wochen").select("*").eq("woche_start", woche).maybeSingle(),
        db.from("schichten").select(SCHICHT_FELDER).eq("offen", true).gte("datum", heute).order("datum"),
      ])
      const offeneIds = (offene.data ?? []).map((s) => s.id)
      const { data: interessen } = offeneIds.length
        ? await db.from("schicht_interessen").select("schicht_id,user_id,created_at").in("schicht_id", offeneIds)
        : { data: [] }
      return Response.json({
        success: true,
        rolle: "admin",
        woche,
        frist: fristFuerWoche(woche, e),
        einstellungen: e,
        bereiche,
        profile: profile.data,
        zuordnung: zuordnung.data,
        schichten: schichten.data,
        verfuegbarkeiten: verf.data,
        wocheStatus: wocheRow.data,
        offene: offene.data,
        interessen,
      })
    }

    // ---- Mitarbeiter
    const ab = montagVon(heute)
    const bis = addTage(ab, 27)
    const verfWoche = offeneVerfuegbarkeitsWoche(berlinJetzt(), e)
    const [wochen, meine, offene, meineInteressen, verf, zuordnung] = await Promise.all([
      db.from("dienstplan_wochen").select("woche_start").not("freigegeben_am", "is", null).gte("woche_start", ab).lte("woche_start", bis),
      db.from("schichten").select(SCHICHT_FELDER).eq("mitarbeiter_id", me.id).gte("datum", ab).lte("datum", bis).order("datum").order("beginn"),
      db.from("schichten").select(SCHICHT_FELDER).eq("offen", true).gte("datum", heute).order("datum").order("beginn"),
      db.from("schicht_interessen").select("schicht_id").eq("user_id", me.id),
      db.from("verfuegbarkeiten").select("datum,verfuegbar,notiz").eq("user_id", me.id).gte("datum", verfWoche).lte("datum", addTage(verfWoche, 6)),
      db.from("mitarbeiter_bereiche").select("bereich_id").eq("user_id", me.id),
    ])
    const freigegeben = new Set((wochen.data ?? []).map((w) => w.woche_start))
    const meineBereiche = (zuordnung.data ?? []).map((z) => z.bereich_id)
    return Response.json({
      success: true,
      rolle: "employee",
      bereiche,
      meineSchichten: (meine.data ?? []).filter((s) => freigegeben.has(montagVon(s.datum))),
      freigegebeneWochen: [...freigegeben].sort(),
      // Offene Schichten nur fuer den eigenen Bereich (ohne Zuordnung: alle)
      offene: (offene.data ?? []).filter((s) => !s.bereich_id || !meineBereiche.length || meineBereiche.includes(s.bereich_id)),
      meineInteressen: (meineInteressen.data ?? []).map((i) => i.schicht_id),
      verfuegbarkeit: { woche: verfWoche, frist: fristFuerWoche(verfWoche, e), tage: verf.data },
    })
  } catch (e) {
    return fehlerAntwort(e)
  }
}

// ---------------------------------------------------------------- POST

export async function POST(req: Request) {
  try {
    const db = adminDb()
    const me = await benutzerAusRequest(req, db)
    const body = await req.json()
    const aktion = String(body.aktion || "")

    const adminAktionen: Record<string, (db: SupabaseClient, me: Benutzer, b: any) => Promise<unknown>> = {
      schicht_speichern: schichtSpeichern,
      schicht_loeschen: schichtLoeschen,
      woche_freigeben: wocheFreigeben,
      woche_kopieren: wocheKopieren,
      offen_vergeben: offenVergeben,
      einstellungen_speichern: einstellungenSpeichern,
      bereiche_setzen: bereicheSetzen,
    }
    const mitarbeiterAktionen: Record<string, (db: SupabaseClient, me: Benutzer, b: any) => Promise<unknown>> = {
      verfuegbarkeit_speichern: verfuegbarkeitSpeichern,
      krank_melden: krankMelden,
      interesse: interesse,
    }

    let fn = mitarbeiterAktionen[aktion]
    if (!fn && adminAktionen[aktion]) {
      if (me.role !== "admin") throw new Fehler("Keine Berechtigung.", 403)
      fn = adminAktionen[aktion]
    }
    if (!fn) throw new Fehler("Unbekannte Aktion.")
    const ergebnis = await fn(db, me, body)
    return Response.json({ success: true, ...(ergebnis as object) })
  } catch (e) {
    return fehlerAntwort(e)
  }
}

// ---------------------------------------------------------------- Regeln serverseitig

async function pruefeFuerPerson(db: SupabaseClient, userId: string, neu: SchichtZeit) {
  const [{ data: p }, { data: v }] = await Promise.all([
    db.from("profiles").select("mitarbeiter_typ,stunden_grenze").eq("id", userId).single(),
    db.from("verfuegbarkeiten").select("verfuegbar").eq("user_id", userId).eq("datum", neu.datum).maybeSingle(),
  ])
  const minijob = p?.mitarbeiter_typ === "minijob"
  const von = minijob ? neu.datum.slice(0, 8) + "01" : montagVon(neu.datum)
  const bis = minijob ? addTage(addTage(von, 31).slice(0, 8) + "01", -1) : addTage(von, 6)
  const { data: andere } = await db
    .from("schichten")
    .select("id,datum,beginn,ende")
    .eq("mitarbeiter_id", userId)
    .gte("datum", addTage(von < neu.datum ? von : neu.datum, -1))
    .lte("datum", addTage(bis > neu.datum ? bis : neu.datum, 1))
  const liste = (andere ?? []).filter((s) => s.id !== neu.id)
  const bisherMin = liste.filter((s) => s.datum >= von && s.datum <= bis).reduce((m, s) => m + arbeitsMinuten(s), 0)
  return pruefeZuweisung(neu, liste, {
    verfuegbar: v?.verfuegbar ?? null,
    grenze: { stunden: Number(p?.stunden_grenze || 0), bisherMin, label: minijob ? "Monatsgrenze" : "Wochengrenze" },
  })
}

// ---------------------------------------------------------------- Admin

async function schichtSpeichern(db: SupabaseClient, _me: Benutzer, b: any) {
  if (!DATUM.test(b.datum) || !ZEIT.test(b.beginn) || !ZEIT.test(b.ende)) throw new Fehler("Datum/Uhrzeit ungültig.")
  const mitarbeiter_id: string | null = b.mitarbeiter_id || null
  const offen = !mitarbeiter_id && !!b.offen
  const neu = {
    datum: b.datum,
    beginn: b.beginn,
    ende: b.ende,
    mitarbeiter_id,
    bereich_id: b.bereich_id || null,
    notiz: (b.notiz || "").toString().slice(0, 280) || null,
    offen,
  }

  let vorher: Schicht | null = null
  if (b.id) {
    const { data } = await db.from("schichten").select(SCHICHT_FELDER).eq("id", b.id).single()
    if (!data) throw new Fehler("Schicht nicht gefunden.", 404)
    vorher = data as Schicht
  }

  let hinweise: string[] = []
  if (mitarbeiter_id) {
    const r = await pruefeFuerPerson(db, mitarbeiter_id, { ...neu, id: b.id })
    if (r.sperren.length) throw new Fehler(r.sperren.join(" "), 409)
    hinweise = r.hinweise
  }

  const daten = {
    ...neu,
    offen_seit: offen ? (vorher?.offen ? vorher.offen_seit : new Date().toISOString()) : null,
    ausfall_grund: mitarbeiter_id ? null : (vorher?.ausfall_grund ?? null),
    // Erinnerung neu verschicken, wenn sich Person oder Zeit aendert
    ...(vorher && (vorher.mitarbeiter_id !== mitarbeiter_id || vorher.datum !== neu.datum || vorher.beginn.slice(0, 5) !== neu.beginn.slice(0, 5))
      ? { erinnert_am: null }
      : {}),
  }
  const { data: gespeichert, error } = b.id
    ? await db.from("schichten").update(daten).eq("id", b.id).select(SCHICHT_FELDER).single()
    : await db.from("schichten").insert(daten).select(SCHICHT_FELDER).single()
  if (error) throw new Fehler(error.message, 500)

  // ---- Benachrichtigen (nur wenn die Woche schon freigegeben ist)
  if (await istFreigegeben(db, neu.datum)) {
    const text = zeitText(neu)
    if (vorher?.mitarbeiter_id && vorher.mitarbeiter_id !== mitarbeiter_id) {
      await pushAn(db, [vorher.mitarbeiter_id], { title: "Schicht entfernt", body: `Du bist nicht mehr eingeteilt: ${zeitText(vorher)}`, tag: "schicht" })
    }
    if (mitarbeiter_id) {
      const geaendert =
        !vorher ||
        vorher.mitarbeiter_id !== mitarbeiter_id ||
        vorher.datum !== neu.datum ||
        vorher.beginn.slice(0, 5) !== neu.beginn.slice(0, 5) ||
        vorher.ende.slice(0, 5) !== neu.ende.slice(0, 5)
      if (geaendert) {
        await pushAn(db, [mitarbeiter_id], {
          title: vorher?.mitarbeiter_id === mitarbeiter_id ? "Schicht geändert" : "Neue Schicht",
          body: text,
          tag: "schicht",
        })
      }
    }
  }
  if (offen && !vorher?.offen) await offeneSchichtAnkuendigen(db, gespeichert as Schicht)

  return { schicht: gespeichert, hinweise }
}

async function offeneSchichtAnkuendigen(db: SupabaseClient, s: Schicht) {
  let ids = await mitarbeiterIds(db)
  if (s.bereich_id) {
    const { data } = await db.from("mitarbeiter_bereiche").select("user_id,bereich_id")
    const mitBereich = new Set((data ?? []).map((z) => z.user_id))
    const passend = new Set((data ?? []).filter((z) => z.bereich_id === s.bereich_id).map((z) => z.user_id))
    ids = ids.filter((id) => !mitBereich.has(id) || passend.has(id))
  }
  await pushAn(db, ids, { title: "Offene Schicht – wer kann?", body: `${zeitText(s)}${s.notiz ? " · " + s.notiz : ""}`, tag: "offen" })
}

async function schichtLoeschen(db: SupabaseClient, _me: Benutzer, b: any) {
  const { data: s } = await db.from("schichten").select(SCHICHT_FELDER).eq("id", b.id).single()
  if (!s) throw new Fehler("Schicht nicht gefunden.", 404)
  await db.from("schichten").delete().eq("id", b.id)
  if (s.mitarbeiter_id && (await istFreigegeben(db, s.datum))) {
    await pushAn(db, [s.mitarbeiter_id], { title: "Schicht gestrichen", body: zeitText(s), tag: "schicht" })
  }
  return {}
}

async function wocheFreigeben(db: SupabaseClient, _me: Benutzer, b: any) {
  if (!DATUM.test(b.woche)) throw new Fehler("Woche ungültig.")
  const woche = montagVon(b.woche)
  const { data: alt } = await db.from("dienstplan_wochen").select("freigegeben_am").eq("woche_start", woche).maybeSingle()
  await db.from("dienstplan_wochen").upsert({ woche_start: woche, freigegeben_am: new Date().toISOString() })

  const { data: schichten } = await db
    .from("schichten")
    .select("datum,beginn,ende,mitarbeiter_id")
    .gte("datum", woche)
    .lte("datum", addTage(woche, 6))
    .not("mitarbeiter_id", "is", null)
    .order("datum")
    .order("beginn")
  const proPerson = new Map<string, string[]>()
  for (const s of schichten ?? []) {
    const l = proPerson.get(s.mitarbeiter_id) ?? []
    l.push(`${datumKurz(s.datum)} ${s.beginn.slice(0, 5)}–${s.ende.slice(0, 5)}`)
    proPerson.set(s.mitarbeiter_id, l)
  }
  const titel = `Dienstplan KW ${kw(woche)} ${alt?.freigegeben_am ? "aktualisiert" : "ist da"}`
  let gesendet = 0
  for (const id of await mitarbeiterIds(db)) {
    const l = proPerson.get(id)
    gesendet += await pushAn(db, [id], {
      title: titel,
      body: l ? `Deine Schichten: ${l.join(", ")}` : "Du hast diese Woche keine Schichten.",
      tag: `plan-${woche}`,
    })
  }
  return { gesendet }
}

async function wocheKopieren(db: SupabaseClient, _me: Benutzer, b: any) {
  const von = montagVon(b.von)
  const nach = montagVon(b.nach)
  const { data: quelle } = await db
    .from("schichten")
    .select("datum,beginn,ende,mitarbeiter_id,bereich_id,notiz")
    .gte("datum", von)
    .lte("datum", addTage(von, 6))
  const { count } = await db.from("schichten").select("id", { count: "exact", head: true }).gte("datum", nach).lte("datum", addTage(nach, 6))
  if (count) throw new Fehler("Die Zielwoche enthält schon Schichten.")
  const diff = (Date.parse(nach) - Date.parse(von)) / 86400000
  const neu = (quelle ?? []).map((s) => ({ ...s, datum: addTage(s.datum, diff) }))
  if (neu.length) {
    const { error } = await db.from("schichten").insert(neu)
    if (error) throw new Fehler(error.message, 500)
  }
  return { anzahl: neu.length }
}

async function offenVergeben(db: SupabaseClient, _me: Benutzer, b: any) {
  const { data: s } = await db.from("schichten").select(SCHICHT_FELDER).eq("id", b.schicht_id).single()
  if (!s || !s.offen) throw new Fehler("Schicht ist nicht mehr offen.", 409)
  const r = await pruefeFuerPerson(db, b.user_id, s)
  if (r.sperren.length) throw new Fehler(r.sperren.join(" "), 409)
  // Bedingtes Update = atomar: nur wenn noch offen
  const { data: upd } = await db
    .from("schichten")
    .update({ mitarbeiter_id: b.user_id, offen: false, offen_seit: null, erinnert_am: null })
    .eq("id", s.id)
    .eq("offen", true)
    .select("id")
  if (!upd?.length) throw new Fehler("Schicht wurde inzwischen vergeben.", 409)
  const { data: interessenten } = await db.from("schicht_interessen").select("user_id").eq("schicht_id", s.id)
  await db.from("schicht_interessen").delete().eq("schicht_id", s.id)
  await pushAn(db, [b.user_id], { title: "Schicht übernommen ✔", body: `Du arbeitest: ${zeitText(s)}`, tag: "schicht" })
  const andere = (interessenten ?? []).map((i) => i.user_id).filter((id) => id !== b.user_id)
  await pushAn(db, andere, { title: "Schicht vergeben", body: `${zeitText(s)} ist besetzt – danke fürs Melden!`, tag: "offen" })
  return { hinweise: r.hinweise }
}

async function einstellungenSpeichern(db: SupabaseClient, _me: Benutzer, b: any) {
  const daten = {
    id: 1,
    frist_wochentag: Math.min(7, Math.max(1, Number(b.frist_wochentag))),
    frist_uhrzeit: ZEIT.test(b.frist_uhrzeit) ? b.frist_uhrzeit : "18:00",
    erinnerung_stunden: Math.min(168, Math.max(1, Number(b.erinnerung_stunden) || 24)),
    schicht_erinnerung_stunden: Math.min(168, Math.max(0, Number(b.schicht_erinnerung_stunden) || 0)),
  }
  const { error } = await db.from("dienstplan_einstellungen").upsert(daten)
  if (error) throw new Fehler(error.message, 500)
  return {}
}

async function bereicheSetzen(db: SupabaseClient, _me: Benutzer, b: any) {
  const ids: string[] = Array.isArray(b.bereich_ids) ? b.bereich_ids : []
  await db.from("mitarbeiter_bereiche").delete().eq("user_id", b.user_id)
  if (ids.length) await db.from("mitarbeiter_bereiche").insert(ids.map((bereich_id) => ({ user_id: b.user_id, bereich_id })))
  return {}
}

// ---------------------------------------------------------------- Mitarbeiter

async function verfuegbarkeitSpeichern(db: SupabaseClient, me: Benutzer, b: any) {
  const e = await einstellungen(db)
  const jetzt = berlinJetzt()
  const erlaubt = offeneVerfuegbarkeitsWoche(jetzt, e)
  const woche = montagVon(String(b.woche || ""))
  if (me.role !== "admin" && woche < erlaubt) throw new Fehler("Die Frist für diese Woche ist abgelaufen.", 409)
  const tage: { datum: string; verfuegbar: boolean; notiz?: string }[] = (b.tage ?? []).filter(
    (t: any) => DATUM.test(t.datum) && montagVon(t.datum) === woche
  )
  const userId = me.role === "admin" && b.user_id ? b.user_id : me.id
  if (tage.length) {
    const { error } = await db.from("verfuegbarkeiten").upsert(
      tage.map((t) => ({
        user_id: userId,
        datum: t.datum,
        verfuegbar: !!t.verfuegbar,
        notiz: (t.notiz || "").toString().slice(0, 140) || null,
        updated_at: new Date().toISOString(),
      }))
    )
    if (error) throw new Fehler(error.message, 500)
  }
  return {}
}

async function krankMelden(db: SupabaseClient, me: Benutzer, b: any) {
  const heute = berlinJetzt().datum
  // Atomar: nur die eigene Schicht, nur heute oder spaeter
  const { data } = await db
    .from("schichten")
    .update({ mitarbeiter_id: null, offen: false, offen_seit: null, ausfall_grund: "krank", erinnert_am: null })
    .eq("id", b.schicht_id)
    .eq("mitarbeiter_id", me.id)
    .gte("datum", heute)
    .select(SCHICHT_FELDER)
  const s = data?.[0]
  if (!s) throw new Fehler("Schicht nicht gefunden oder schon vorbei.", 404)
  await pushAn(db, await adminIds(db), {
    title: `🤒 Krankmeldung: ${me.full_name}`,
    body: `${zeitText(s)} ist jetzt unbesetzt. Bitte Ersatz finden.`,
    tag: `krank-${s.id}`,
  })
  return {}
}

async function interesse(db: SupabaseClient, me: Benutzer, b: any) {
  const { data: s } = await db.from("schichten").select(SCHICHT_FELDER).eq("id", b.schicht_id).single()
  if (!s?.offen) throw new Fehler("Schicht ist nicht mehr offen.", 409)
  if (!b.an) {
    await db.from("schicht_interessen").delete().eq("schicht_id", s.id).eq("user_id", me.id)
    return {}
  }
  const r = await pruefeFuerPerson(db, me.id, s)
  if (r.sperren.length) throw new Fehler(r.sperren.join(" "), 409)
  await db.from("schicht_interessen").upsert({ schicht_id: s.id, user_id: me.id })
  await pushAn(db, await adminIds(db), {
    title: `🙋 ${me.full_name} könnte übernehmen`,
    body: zeitText(s),
    tag: `interesse-${s.id}`,
  })
  return {}
}
