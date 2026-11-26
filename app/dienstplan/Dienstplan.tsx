/* eslint-disable @typescript-eslint/no-explicit-any -- API-Antworten sind lose typisiert */
"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import * as XLSX from "xlsx"
import { supabase } from "@/lib/supabase"
import {
  addTage,
  arbeitsMinuten,
  berlinJetzt,
  formatStunden,
  montagVon,
  pruefeZuweisung,
  wochentag,
} from "@/lib/dienstplan/regeln"

// ---------------------------------------------------------------- Typen & Helfer

type Bereich = { id: string; name: string; farbe: string }
type Schicht = {
  id: string
  datum: string
  beginn: string
  ende: string
  mitarbeiter_id: string | null
  bereich_id: string | null
  notiz: string | null
  offen: boolean
  offen_seit: string | null
  ausfall_grund: string | null
}
type Person = { id: string; full_name: string; role: string; mitarbeiter_typ: string; stunden_grenze: number }
type Verf = { user_id?: string; datum: string; verfuegbar: boolean; notiz: string | null }
type Einstellungen = { frist_wochentag: number; frist_uhrzeit: string; erinnerung_stunden: number; schicht_erinnerung_stunden: number }

const TAGE = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]
const TYP_LABEL: Record<string, string> = { vollzeit: "Vollzeit", teilzeit: "Teilzeit", minijob: "Minijob" }
const TAGE_LANG = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]

async function api(method: "GET" | "POST", query: string, body?: unknown) {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  const res = await fetch(`/api/dienstplan${query}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({ success: false, error: "Serverfehler." }))
  if (!json.success) throw new Error(json.error || "Fehler")
  return json
}

function datumText(d: string) {
  const [, m, t] = d.split("-")
  return `${TAGE[wochentag(d) - 1]} ${t}.${m}.`
}
const hhmm = (t: string) => t.slice(0, 5)
const zeitText = (s: { beginn: string; ende: string }) => `${hhmm(s.beginn)}–${hhmm(s.ende)}`

function kw(datum: string) {
  const d = new Date(datum + "T00:00:00Z")
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  return Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7)
}

const karte = "rounded-2xl bg-white p-6 shadow"
const knopf = "rounded-lg border px-3 py-2 text-sm font-medium hover:bg-neutral-100 disabled:opacity-50"
const knopfDunkel = "rounded-lg bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50"

function Meldung({ text, fehler }: { text: string; fehler?: boolean }) {
  if (!text) return null
  return (
    <div className={`rounded-xl px-4 py-3 text-sm ${fehler ? "bg-red-50 text-red-700" : "bg-green-50 text-green-800"}`}>{text}</div>
  )
}

// ---------------------------------------------------------------- Zeiterfassung

export type Geplant = Record<string, { beginn: string; ende: string; text: string }>

/** Freigegebene eigene Schichten je Tag (fuer das Vorausfuellen der Zeiterfassung). */
export async function ladeGeplanteSchichten(): Promise<Geplant> {
  const j = await api("GET", "")
  const out: Geplant = {}
  for (const s of (j.meineSchichten ?? []) as Schicht[]) {
    const alt = out[s.datum]
    if (!alt) out[s.datum] = { beginn: hhmm(s.beginn), ende: hhmm(s.ende), text: zeitText(s) }
    else {
      // geteilter Dienst: fruehester Beginn bis spaetestes Ende
      out[s.datum] = { beginn: alt.beginn, ende: hhmm(s.ende), text: `${alt.text}, ${zeitText(s)}` }
    }
  }
  return out
}

// ---------------------------------------------------------------- Push

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/")
  const raw = window.atob(base64)
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

/** Registriert den Service Worker und zeigt den Push-Status. */
export function PushKarte({ rolle }: { rolle: "admin" | "employee" }) {
  const [status, setStatus] = useState<"laden" | "nicht-unterstuetzt" | "ios-installieren" | "aus" | "an" | "blockiert">("laden")
  const [meldung, setMeldung] = useState("")

  useEffect(() => {
    ;(async () => {
      const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setStatus(ios && !standalone ? "ios-installieren" : "nicht-unterstuetzt")
        return
      }
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
      const sub = await reg.pushManager.getSubscription()
      if (Notification.permission === "denied") setStatus("blockiert")
      else setStatus(sub ? "an" : "aus")
      // Abo bei jedem Start erneut melden (falls DB-Eintrag fehlt oder Login wechselte)
      if (sub) await pushApi("POST", { subscription: sub.toJSON() }).catch(() => {})
    })()
  }, [])

  async function pushApi(method: "POST" | "DELETE", body: unknown) {
    const { data } = await supabase.auth.getSession()
    const res = await fetch("/api/push", {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token}` },
      body: JSON.stringify(body),
    })
    return res.json()
  }

  async function aktivieren() {
    setMeldung("")
    try {
      const erlaubnis = await Notification.requestPermission()
      if (erlaubnis !== "granted") {
        setStatus("blockiert")
        return
      }
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!),
      })
      await pushApi("POST", { subscription: sub.toJSON() })
      setStatus("an")
      await testen()
    } catch (e) {
      setMeldung("Aktivieren fehlgeschlagen: " + (e as Error).message)
    }
  }

  async function testen() {
    setMeldung("Sende Test …")
    try {
      const j = await pushApi("POST", { test: true, clientKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY })
      setMeldung(j.success ? `✔ Gesendet an ${j.gesendet} Gerät(e). Kommt nichts an: Mitteilungen in den Handy-Einstellungen prüfen.` : `✖ ${j.error}`)
    } catch (e) {
      setMeldung("✖ " + (e as Error).message)
    }
  }

  async function deaktivieren() {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) {
      await pushApi("DELETE", { endpoint: sub.endpoint })
      await sub.unsubscribe()
    }
    setStatus("aus")
  }

  if (status === "an")
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-white px-6 py-3 text-sm shadow">
        <span>🔔 Benachrichtigungen sind auf diesem Gerät aktiv.</span>
        <span className="flex gap-2">
          <button className={knopf} onClick={testen}>Test</button>
          <button className={knopf} onClick={deaktivieren}>Aus</button>
        </span>
        {meldung && <p className={`w-full text-xs ${meldung.startsWith("✖") ? "text-red-700" : "text-green-700"}`}>{meldung}</p>}
      </div>
    )

  return (
    <div className="rounded-2xl border-2 border-orange bg-orange-soft p-5 text-sm text-[#1b2536] shadow">
      <p className="font-semibold">🔔 Benachrichtigungen aktivieren – wichtig!</p>
      <p className="mt-1">
        {rolle === "admin"
          ? "Damit du sofort von Krankmeldungen und Ersatz-Angeboten erfährst."
          : "Damit du den Dienstplan, Änderungen und Erinnerungen sofort aufs Handy bekommst."}
      </p>
      {status === "ios-installieren" && (
        <p className="mt-2">
          iPhone: Unten auf <b>Teilen</b> (□↑) tippen → <b>„Zum Home-Bildschirm“</b> → App vom Home-Bildschirm öffnen,
          einloggen und hier „Aktivieren“ tippen.
        </p>
      )}
      {status === "nicht-unterstuetzt" && <p className="mt-2">Dieser Browser unterstützt keine Benachrichtigungen. Bitte Chrome oder Safari nutzen.</p>}
      {status === "blockiert" && (
        <p className="mt-2">Benachrichtigungen sind blockiert. Bitte in den Handy-Einstellungen für diese App/Seite erlauben.</p>
      )}
      {status === "aus" && (
        <>
          <p className="mt-2 text-xs text-neutral-600">
            Tipp: Zuerst die Seite als App auf den Home-Bildschirm legen (Android: Menü ⋮ → „App installieren“).
          </p>
          <button className={`${knopfDunkel} mt-3`} onClick={aktivieren}>Aktivieren</button>
        </>
      )}
      {meldung && <p className="mt-2 text-red-700">{meldung}</p>}
    </div>
  )
}

// ================================================================ MITARBEITER

export function MitarbeiterDienstplan() {
  const [d, setD] = useState<any>(null)
  const [verf, setVerf] = useState<Record<string, boolean | undefined>>({})
  const [meldung, setMeldung] = useState({ text: "", fehler: false })
  const [busy, setBusy] = useState(false)

  const laden = useCallback(
    () =>
      api("GET", "")
        .then((j) => {
          setD(j)
          const v: Record<string, boolean> = {}
          for (const t of j.verfuegbarkeit.tage ?? []) v[t.datum] = t.verfuegbar
          setVerf(v)
        })
        .catch((e) => setMeldung({ text: (e as Error).message, fehler: true })),
    []
  )
  useEffect(() => {
    laden()
  }, [laden])

  async function aktion(body: object, ok: string) {
    setBusy(true)
    setMeldung({ text: "", fehler: false })
    try {
      await api("POST", "", body)
      setMeldung({ text: ok, fehler: false })
      await laden()
    } catch (e) {
      setMeldung({ text: (e as Error).message, fehler: true })
    } finally {
      setBusy(false)
    }
  }

  if (!d) return <div className={karte}>Lade Dienstplan …</div>

  const bereich = (id: string | null) => d.bereiche.find((b: Bereich) => b.id === id)
  const vWoche: string = d.verfuegbarkeit.woche
  const vTage = Array.from({ length: 7 }, (_, i) => addTage(vWoche, i))
  const alleEingetragen = vTage.every((t) => verf[t] !== undefined)
  const heute = berlinJetzt().datum
  const nachWoche = new Map<string, Schicht[]>()
  for (const s of d.meineSchichten as Schicht[]) {
    const w = montagVon(s.datum)
    nachWoche.set(w, [...(nachWoche.get(w) ?? []), s])
  }

  return (
    <div className="space-y-6">
      <PushKarte rolle="employee" />
      <Meldung {...meldung} />

      {/* ---- Meine Schichten */}
      <div className={karte}>
        <h2 className="text-xl font-bold">Mein Dienstplan</h2>
        {(d.freigegebeneWochen as string[]).length === 0 && (
          <p className="mt-2 text-sm text-neutral-500">Noch kein Dienstplan freigegeben. Du bekommst eine Benachrichtigung.</p>
        )}
        {(d.freigegebeneWochen as string[]).map((w) => (
          <div key={w} className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              KW {kw(w)} · {datumText(w)} – {datumText(addTage(w, 6))}
            </p>
            {(nachWoche.get(w) ?? []).length === 0 && <p className="mt-1 text-sm text-neutral-500">Keine Schichten.</p>}
            <ul className="mt-2 space-y-2">
              {(nachWoche.get(w) ?? []).map((s) => {
                const b = bereich(s.bereich_id)
                return (
                  <li key={s.id} className="flex items-center justify-between gap-3 rounded-xl border p-3" style={{ borderLeft: `6px solid ${b?.farbe ?? "#999"}` }}>
                    <div>
                      <p className="font-semibold">{datumText(s.datum)} · {zeitText(s)}</p>
                      <p className="text-xs text-neutral-500">{b?.name ?? "–"}{s.notiz ? ` · ${s.notiz}` : ""}</p>
                    </div>
                    {s.datum >= heute && (
                      <button
                        disabled={busy}
                        className="rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50"
                        onClick={() => {
                          if (confirm(`Für ${datumText(s.datum)} ${zeitText(s)} krank melden? Die Leitung wird sofort benachrichtigt.`))
                            aktion({ aktion: "krank_melden", schicht_id: s.id }, "Krankmeldung gesendet. Gute Besserung!")
                        }}
                      >
                        🤒 Krank
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>

      {/* ---- Offene Schichten */}
      {(d.offene as Schicht[]).length > 0 && (
        <div className={karte}>
          <h2 className="text-xl font-bold">Offene Schichten</h2>
          <p className="text-sm text-neutral-500">Kannst du einspringen? Die Leitung entscheidet und du bekommst Bescheid.</p>
          <ul className="mt-3 space-y-2">
            {(d.offene as Schicht[]).map((s) => {
              const gemeldet = (d.meineInteressen as string[]).includes(s.id)
              return (
                <li key={s.id} className="flex items-center justify-between gap-3 rounded-xl border p-3">
                  <div>
                    <p className="font-semibold">{datumText(s.datum)} · {zeitText(s)}</p>
                    <p className="text-xs text-neutral-500">{bereich(s.bereich_id)?.name ?? "–"}{s.notiz ? ` · ${s.notiz}` : ""}</p>
                  </div>
                  <button
                    disabled={busy}
                    className={gemeldet ? knopf : knopfDunkel}
                    onClick={() => aktion({ aktion: "interesse", schicht_id: s.id, an: !gemeldet }, gemeldet ? "Zurückgezogen." : "Danke! Die Leitung ist informiert.")}
                  >
                    {gemeldet ? "✔ Gemeldet (zurückziehen)" : "🙋 Ich könnte"}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* ---- Verfuegbarkeit */}
      <div className={karte}>
        <h2 className="text-xl font-bold">Meine Verfügbarkeit</h2>
        <p className="text-sm text-neutral-600">
          Woche ab <b>{datumText(vWoche)}</b> · eintragen bis <b>{datumText(d.verfuegbarkeit.frist.datum)} {d.verfuegbarkeit.frist.zeit} Uhr</b>
        </p>
        {!alleEingetragen && <p className="mt-1 text-xs font-medium text-orange-strong">Bitte jeden Tag auswählen.</p>}
        <div className="mt-4 space-y-2">
          {vTage.map((t) => (
            <div key={t} className="flex items-center justify-between gap-2 rounded-xl border p-2 pl-3">
              <span className="text-sm font-medium">{datumText(t)}</span>
              <span className="flex gap-1">
                <button
                  onClick={() => setVerf((v) => ({ ...v, [t]: true }))}
                  className={`rounded-lg px-3 py-2 text-sm ${verf[t] === true ? "bg-green-600 text-white" : "border"}`}
                >
                  Kann
                </button>
                <button
                  onClick={() => setVerf((v) => ({ ...v, [t]: false }))}
                  className={`rounded-lg px-3 py-2 text-sm ${verf[t] === false ? "bg-red-600 text-white" : "border"}`}
                >
                  Kann nicht
                </button>
              </span>
            </div>
          ))}
        </div>
        <button
          disabled={busy || !alleEingetragen}
          className={`${knopfDunkel} mt-4 w-full`}
          onClick={() =>
            aktion(
              { aktion: "verfuegbarkeit_speichern", woche: vWoche, tage: vTage.map((t) => ({ datum: t, verfuegbar: verf[t] })) },
              "Verfügbarkeit gespeichert ✔"
            )
          }
        >
          Verfügbarkeit speichern
        </button>
      </div>
    </div>
  )
}

// ================================================================ ADMIN

type Dialog = { schicht: Partial<Schicht> & { datum: string } } | null

export function AdminDienstplan() {
  const [woche, setWoche] = useState(() => addTage(montagVon(berlinJetzt().datum), 7))
  const [d, setD] = useState<any>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [meldung, setMeldung] = useState({ text: "", fehler: false })
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<"plan" | "einstellungen">("plan")

  const laden = useCallback(
    () =>
      api("GET", `?woche=${woche}`)
        .then(setD)
        .catch((e) => setMeldung({ text: (e as Error).message, fehler: true })),
    [woche]
  )
  useEffect(() => {
    laden()
  }, [laden])

  async function aktion(body: object, ok: string) {
    setBusy(true)
    setMeldung({ text: "", fehler: false })
    try {
      const j = await api("POST", "", body)
      const hinweise: string[] = j.hinweise ?? []
      setMeldung({ text: [ok, ...hinweise.map((h) => "⚠ " + h)].join(" "), fehler: false })
      await laden()
      return true
    } catch (e) {
      setMeldung({ text: (e as Error).message, fehler: true })
      return false
    } finally {
      setBusy(false)
    }
  }

  const tage = useMemo(() => Array.from({ length: 7 }, (_, i) => addTage(woche, i)), [woche])
  if (!d) return <div className={karte}>Lade Dienstplan …</div>

  const personen: Person[] = (d.profile as Person[]).filter((p) => p.role === "employee")
  const bereiche: Bereich[] = d.bereiche
  const alle: Schicht[] = d.schichten
  const inWoche = alle.filter((s) => s.datum >= woche && s.datum <= tage[6])
  const verfMap = new Map<string, Verf>((d.verfuegbarkeiten as Verf[]).map((v) => [`${v.user_id}|${v.datum}`, v]))
  const bereichVon = (id: string | null) => bereiche.find((b) => b.id === id)
  const wochenMin = (uid: string) => inWoche.filter((s) => s.mitarbeiter_id === uid).reduce((m, s) => m + arbeitsMinuten(s), 0)
  const freigegeben = d.wocheStatus?.freigegeben_am
  const unbesetzt = inWoche.filter((s) => !s.mitarbeiter_id)
  const fehlendeVerf = personen.filter((p) => !tage.some((t) => verfMap.has(`${p.id}|${t}`)))

  function exportieren() {
    const rows = [["Mitarbeiter", ...tage.map(datumText), "Stunden"]]
    for (const p of personen) {
      rows.push([
        p.full_name,
        ...tage.map((t) =>
          inWoche
            .filter((s) => s.mitarbeiter_id === p.id && s.datum === t)
            .map((s) => `${zeitText(s)} ${bereichVon(s.bereich_id)?.name ?? ""}`.trim())
            .join(" / ")
        ),
        (wochenMin(p.id) / 60).toFixed(1).replace(".", ","),
      ])
    }
    rows.push(["Unbesetzt", ...tage.map((t) => unbesetzt.filter((s) => s.datum === t).map(zeitText).join(" / ")), ""])
    const ws = XLSX.utils.aoa_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, `KW ${kw(woche)}`)
    XLSX.writeFile(wb, `dienstplan-kw${kw(woche)}-${woche}.xlsx`)
  }

  return (
    <div className="space-y-6">
      <PushKarte rolle="admin" />

      <div className={`${karte} flex flex-wrap items-center justify-between gap-3`}>
        <div>
          <h2 className="text-2xl font-bold">Dienstplan</h2>
          <p className="text-sm text-neutral-600">
            KW {kw(woche)} · {datumText(woche)} – {datumText(tage[6])} ·{" "}
            {freigegeben ? (
              <span className="font-medium text-green-700">freigegeben ✔</span>
            ) : (
              <span className="font-medium text-orange-strong">Entwurf (Team sieht ihn noch nicht)</span>
            )}
          </p>
          <p className="text-xs text-neutral-500">
            Verfügbarkeits-Frist: {datumText(d.frist.datum)} {d.frist.zeit} Uhr
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={knopf} onClick={() => setWoche(addTage(woche, -7))}>←</button>
          <button className={knopf} onClick={() => setWoche(montagVon(berlinJetzt().datum))}>Heute</button>
          <button className={knopf} onClick={() => setWoche(addTage(woche, 7))}>→</button>
          <button className={knopf} onClick={() => setTab(tab === "plan" ? "einstellungen" : "plan")}>
            {tab === "plan" ? "⚙ Einstellungen" : "← Zum Plan"}
          </button>
        </div>
      </div>

      <Meldung {...meldung} />

      {tab === "einstellungen" ? (
        <EinstellungenAdmin d={d} personen={personen} bereiche={bereiche} aktion={aktion} busy={busy} />
      ) : (
        <>
          {/* ---- Offene / unbesetzte Schichten mit Interessenten */}
          {(d.offene as Schicht[]).length > 0 && (
            <div className={karte}>
              <h3 className="text-lg font-bold">Offene Schichten (Team sieht sie)</h3>
              <ul className="mt-3 space-y-2">
                {(d.offene as Schicht[]).map((s) => {
                  const inter = (d.interessen as { schicht_id: string; user_id: string }[]).filter((i) => i.schicht_id === s.id)
                  return (
                    <li key={s.id} className="rounded-xl border p-3">
                      <p className="font-semibold">
                        {datumText(s.datum)} · {zeitText(s)} · {bereichVon(s.bereich_id)?.name ?? "–"}
                        {s.ausfall_grund === "krank" && <span className="ml-2 text-xs text-red-600">(Krankheitsausfall)</span>}
                      </p>
                      {inter.length === 0 ? (
                        <p className="text-sm text-neutral-500">Noch niemand gemeldet.</p>
                      ) : (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {inter.map((i) => (
                            <button
                              key={i.user_id}
                              disabled={busy}
                              className={knopfDunkel}
                              onClick={() => aktion({ aktion: "offen_vergeben", schicht_id: s.id, user_id: i.user_id }, "Vergeben ✔ – Person wurde benachrichtigt.")}
                            >
                              🙋 {d.profile.find((p: Person) => p.id === i.user_id)?.full_name} einteilen
                            </button>
                          ))}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          <Abgleich d={d} personen={personen} tage={tage} inWoche={inWoche} />

          {/* ---- Wochenraster */}
          <div className={`${karte} p-3 md:p-5`}>
            <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
              <button
                className={knopf}
                disabled={busy || inWoche.length > 0}
                title={inWoche.length > 0 ? "Nur für leere Wochen" : ""}
                onClick={() => aktion({ aktion: "woche_kopieren", von: addTage(woche, -7), nach: woche }, "Vorwoche übernommen.")}
              >
                Vorwoche kopieren
              </button>
              <button className={knopf} onClick={exportieren}>Excel</button>
              <button
                className={knopfDunkel}
                disabled={busy}
                onClick={() => {
                  const txt = freigegeben
                    ? "Plan erneut freigeben? Alle bekommen eine Push-Nachricht „Dienstplan aktualisiert“."
                    : `Dienstplan KW ${kw(woche)} freigeben? Alle Mitarbeitenden bekommen eine Push-Nachricht mit ihren Schichten.`
                  if (confirm(txt)) aktion({ aktion: "woche_freigeben", woche }, "Freigegeben – alle wurden benachrichtigt 📣")
                }}
              >
                {freigegeben ? "Erneut freigeben" : "📣 Freigeben & benachrichtigen"}
              </button>
            </div>

            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full min-w-[960px] table-fixed border-collapse text-sm">
                <colgroup>
                  <col className="w-[210px]" />
                  {tage.map((t) => <col key={t} />)}
                  <col className="w-[84px]" />
                </colgroup>
                <thead>
                  <tr className="bg-neutral-50">
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">Mitarbeiter</th>
                    {tage.map((t) => {
                      const heute = t === berlinJetzt().datum
                      return (
                        <th key={t} className={`px-1 py-3 text-center ${heute ? "bg-orange-soft/60" : ""}`}>
                          <p className={`font-semibold ${heute ? "text-orange-strong" : ""}`}>{TAGE[wochentag(t) - 1]}</p>
                          <p className="text-xs font-normal text-neutral-500">{t.slice(8, 10)}.{t.slice(5, 7)}.</p>
                        </th>
                      )
                    })}
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wide text-neutral-500">Std.</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Besetzung je Tag */}
                  <tr className="border-t bg-orange-soft/30">
                    <td className="px-4 py-2">
                      <p className="font-semibold">Besetzung</p>
                      <p className="text-xs text-neutral-500">Schichten / Stunden</p>
                    </td>
                    {tage.map((t) => {
                      const tag = inWoche.filter((s) => s.datum === t)
                      const besetzt = tag.filter((s) => s.mitarbeiter_id)
                      const std = besetzt.reduce((m, s) => m + arbeitsMinuten(s), 0) / 60
                      const offen = tag.length - besetzt.length
                      return (
                        <td key={t} className="px-1 py-2 text-center text-xs">
                          {tag.length === 0 ? (
                            <span className="text-neutral-400">—</span>
                          ) : (
                            <>
                              <p className="font-medium">{besetzt.length} {besetzt.length === 1 ? "Schicht" : "Schichten"} · {std.toLocaleString("de-DE", { maximumFractionDigits: 1 })} Std.</p>
                              <div className="mt-1 flex justify-center gap-1">
                                {bereiche.map((b) => {
                                  const n = besetzt.filter((s) => s.bereich_id === b.id).length
                                  return n ? (
                                    <span key={b.id} className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-white" style={{ background: b.farbe }}>
                                      {b.name.charAt(0)} {n}
                                    </span>
                                  ) : null
                                })}
                              </div>
                              {offen > 0 && (
                                <span className="mt-1 inline-block rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">⚠ {offen} unbesetzt</span>
                              )}
                            </>
                          )}
                        </td>
                      )
                    })}
                    <td />
                  </tr>

                  {/* Unbesetzte Schichten */}
                  <tr className="border-t">
                    <td className="px-4 py-2">
                      <p className="font-semibold text-neutral-700">Unbesetzt</p>
                      <p className="text-xs text-neutral-500">ohne Person / offen</p>
                    </td>
                    {tage.map((t) => (
                      <td key={t} className="p-1 align-top">
                        {unbesetzt.filter((s) => s.datum === t).map((s) => (
                          <SchichtChip key={s.id} s={s} b={bereichVon(s.bereich_id)} onClick={() => setDialog({ schicht: s })} />
                        ))}
                        <button
                          className="flex h-9 w-full items-center justify-center rounded-lg border border-dashed text-xs text-neutral-400 hover:border-neutral-400 hover:text-neutral-600"
                          onClick={() => setDialog({ schicht: { datum: t, mitarbeiter_id: null } })}
                        >
                          + Schicht
                        </button>
                      </td>
                    ))}
                    <td />
                  </tr>

                  {personen.map((p) => {
                    const min = wochenMin(p.id)
                    const wochenGrenze = p.mitarbeiter_typ !== "minijob" && p.stunden_grenze > 0 ? p.stunden_grenze : 0
                    const zuViel = wochenGrenze > 0 && min > wochenGrenze * 60
                    return (
                      <tr key={p.id} className="border-t">
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-3">
                            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-orange-soft text-sm font-semibold text-orange-strong">
                              {p.full_name.trim().charAt(0).toUpperCase()}
                            </span>
                            <div className="min-w-0">
                              <p className="truncate font-medium">{p.full_name}</p>
                              <p className="truncate text-xs text-neutral-500">
                                {TYP_LABEL[p.mitarbeiter_typ] ?? p.mitarbeiter_typ}
                                {p.stunden_grenze > 0 ? ` · ${p.stunden_grenze} Std./${p.mitarbeiter_typ === "minijob" ? "Monat" : "Woche"}` : ""}
                              </p>
                            </div>
                          </div>
                        </td>
                        {tage.map((t) => {
                          const v = verfMap.get(`${p.id}|${t}`)
                          const eigene = inWoche.filter((s) => s.mitarbeiter_id === p.id && s.datum === t)
                          const neu = () => setDialog({ schicht: { datum: t, mitarbeiter_id: p.id } })
                          return (
                            <td key={t} className="p-1 align-middle">
                              {eigene.map((s) => (
                                <SchichtChip key={s.id} s={s} b={bereichVon(s.bereich_id)} onClick={() => setDialog({ schicht: s })} />
                              ))}
                              {eigene.length === 0 ? (
                                <button
                                  onClick={neu}
                                  title="Schicht anlegen"
                                  className={`flex h-9 w-full items-center justify-center rounded-lg text-xs font-medium transition ${
                                    v?.verfuegbar === false
                                      ? "bg-red-50 text-red-600 hover:bg-red-100"
                                      : v?.verfuegbar
                                        ? "bg-green-50 text-green-700 hover:bg-green-100"
                                        : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200"
                                  }`}
                                >
                                  {v?.verfuegbar === false ? "Kann nicht" : v?.verfuegbar ? "Kann ✓" : "Frei"}
                                </button>
                              ) : (
                                <button onClick={neu} className="w-full rounded text-[11px] text-neutral-400 hover:text-neutral-700">
                                  + weitere
                                </button>
                              )}
                            </td>
                          )
                        })}
                        <td className={`px-3 py-2 text-right ${zuViel ? "font-bold text-red-600" : ""}`}>
                          <p className="font-semibold">{(min / 60).toLocaleString("de-DE", { maximumFractionDigits: 1 })}</p>
                          {wochenGrenze > 0 && <p className="text-[11px] text-neutral-400">von {wochenGrenze}</p>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-neutral-600">
              {bereiche.map((b) => (
                <span key={b.id} className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: b.farbe }} /> {b.name}
                </span>
              ))}
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-neutral-300" /> Frei (nichts eingetragen)</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-green-500" /> Kann</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-red-500" /> Kann nicht</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-pink-300" /> Krank</span>
            </div>
            {fehlendeVerf.length > 0 && (
              <p className="mt-3 rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
                <b>Noch keine Verfügbarkeit ({fehlendeVerf.length}):</b> {fehlendeVerf.map((p) => p.full_name).join(", ")}
              </p>
            )}
          </div>
        </>
      )}

      {dialog && (
        <SchichtDialog
          start={dialog.schicht}
          personen={personen}
          bereiche={bereiche}
          alle={alle}
          verfMap={verfMap}
          zuordnung={d.zuordnung}
          interessen={d.interessen}
          busy={busy}
          onClose={() => setDialog(null)}
          onSave={async (s) => {
            if (await aktion({ aktion: "schicht_speichern", ...s }, "Gespeichert.")) setDialog(null)
          }}
          onDelete={async (id) => {
            if (confirm("Schicht löschen?") && (await aktion({ aktion: "schicht_loeschen", id }, "Gelöscht."))) setDialog(null)
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- Abgleich Plan <-> Zeiterfassung

type Zeit = { user_id: string; work_date: string; entry_type: string; start_time: string | null; end_time: string | null; break_minutes: number }
const TYP_ZEIT: Record<string, string> = { vacation: "Urlaub", sick: "Krank", day_off: "Frei", holiday: "Feiertag" }

function Abgleich({ d, personen, tage, inWoche }: { d: any; personen: Person[]; tage: string[]; inWoche: Schicht[] }) {
  const heute = berlinJetzt().datum
  const zeiten: Zeit[] = d.zeiten ?? []
  const vergangen = tage.filter((t) => t <= heute)
  if (!vergangen.length) return null

  type Zeile = { p: Person; datum: string; plan: string; ist: string; art: "fehlt" | "abweichung" | "ohne-plan" | "anders" }
  const zeilen: Zeile[] = []
  for (const p of personen) {
    for (const t of vergangen) {
      const plan = inWoche.filter((s) => s.mitarbeiter_id === p.id && s.datum === t)
      const z = zeiten.find((x) => x.user_id === p.id && x.work_date === t)
      const planMin = plan.reduce((m, s) => m + dauerMinutenLokal(s.beginn, s.ende), 0)
      const planText = plan.map(zeitText).join(", ")
      const arbeit = z?.entry_type === "work" && z.start_time && z.end_time
      const istMin = arbeit ? dauerMinutenLokal(z!.start_time!, z!.end_time!) : 0
      const istText = arbeit ? `${hhmm(z!.start_time!)}–${hhmm(z!.end_time!)}` : z ? TYP_ZEIT[z.entry_type] ?? "–" : "–"
      if (plan.length && !z) {
        // heute erst nach Schichtende als fehlend melden
        const ende = plan.map((s) => hhmm(s.ende)).sort().pop()!
        if (t === heute && berlinJetzt().zeit < ende && ende > hhmm(plan[0].beginn)) continue
        zeilen.push({ p, datum: t, plan: planText, ist: "nicht eingetragen", art: "fehlt" })
      } else if (plan.length && !arbeit) {
        zeilen.push({ p, datum: t, plan: planText, ist: istText, art: "anders" })
      } else if (plan.length && Math.abs(istMin - planMin) >= 30) {
        const diff = istMin - planMin
        zeilen.push({ p, datum: t, plan: planText, ist: `${istText} (${diff > 0 ? "+" : "−"}${formatStunden(Math.abs(diff))})`, art: "abweichung" })
      } else if (!plan.length && arbeit) {
        zeilen.push({ p, datum: t, plan: "–", ist: istText, art: "ohne-plan" })
      }
    }
  }

  const farbe = { fehlt: "bg-red-100 text-red-700", abweichung: "bg-amber-100 text-amber-800", "ohne-plan": "bg-blue-100 text-blue-700", anders: "bg-neutral-100 text-neutral-700" }
  const label = { fehlt: "Nicht erfasst", abweichung: "Abweichung", "ohne-plan": "Ohne Schicht", anders: "Anders erfasst" }

  return (
    <div className={karte}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-bold">Abgleich Plan ↔ Zeiterfassung</h3>
        <span className="text-xs text-neutral-500">bis heute · Abweichungen ab 30 Min.</span>
      </div>
      {zeilen.length === 0 ? (
        <p className="mt-2 text-sm text-green-700">✔ Alles passt – alle geplanten Schichten sind erfasst.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="py-2">Mitarbeiter</th>
                <th className="py-2">Tag</th>
                <th className="py-2">Geplant</th>
                <th className="py-2">Erfasst</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {zeilen.map((z) => (
                <tr key={z.p.id + z.datum} className="border-t">
                  <td className="py-2 font-medium">{z.p.full_name}</td>
                  <td className="py-2">{datumText(z.datum)}</td>
                  <td className="py-2">{z.plan}</td>
                  <td className="py-2">{z.ist}</td>
                  <td className="py-2 text-right">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${farbe[z.art]}`}>{label[z.art]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function dauerMinutenLokal(beginn: string, ende: string) {
  const a = Number(beginn.slice(0, 2)) * 60 + Number(beginn.slice(3, 5))
  let b = Number(ende.slice(0, 2)) * 60 + Number(ende.slice(3, 5))
  if (b <= a) b += 1440
  return b - a
}

function SchichtChip({ s, b, onClick }: { s: Schicht; b?: Bereich; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`mb-1 block w-full rounded-lg border-l-4 px-2 py-1.5 text-left transition hover:brightness-95 ${
        s.ausfall_grund === "krank" && !s.mitarbeiter_id ? "bg-pink-50" : ""
      }`}
      style={{ borderColor: b?.farbe ?? "#6b7280", background: s.ausfall_grund === "krank" && !s.mitarbeiter_id ? undefined : `${b?.farbe ?? "#6b7280"}1f` }}
      title={s.notiz ?? ""}
    >
      <span className="block text-xs font-semibold text-[#1b2536]">{zeitText(s)}</span>
      <span className="block truncate text-[10px] text-neutral-600">
        {b?.name ?? "–"}
        {s.offen && " · angeboten"}
        {s.ausfall_grund === "krank" && !s.mitarbeiter_id && " · 🤒 krank"}
        {s.notiz && " · 📝"}
      </span>
    </button>
  )
}

// ---------------------------------------------------------------- Schicht-Dialog ("Schicht besetzen")

function SchichtDialog({
  start,
  personen,
  bereiche,
  alle,
  verfMap,
  zuordnung,
  interessen,
  busy,
  onClose,
  onSave,
  onDelete,
}: {
  start: Partial<Schicht> & { datum: string }
  personen: Person[]
  bereiche: Bereich[]
  alle: Schicht[]
  verfMap: Map<string, Verf>
  zuordnung: { user_id: string; bereich_id: string }[]
  interessen: { schicht_id: string; user_id: string }[]
  busy: boolean
  onClose: () => void
  onSave: (s: object) => void
  onDelete: (id: string) => void
}) {
  const [s, setS] = useState({
    id: start.id,
    datum: start.datum,
    beginn: start.beginn ? hhmm(start.beginn) : "17:00",
    ende: start.ende ? hhmm(start.ende) : "23:00",
    mitarbeiter_id: start.mitarbeiter_id ?? "",
    bereich_id:
      start.bereich_id ??
      (start.mitarbeiter_id ? zuordnung.find((z) => z.user_id === start.mitarbeiter_id)?.bereich_id : undefined) ??
      bereiche[0]?.id ??
      "",
    notiz: start.notiz ?? "",
    offen: start.offen ?? false,
  })

  // Status je Person fuer diese Schicht (Vorschau; Server prueft verbindlich)
  const kandidaten = useMemo(() => {
    const woche = montagVon(s.datum)
    return personen
      .map((p) => {
        const eigene = alle.filter((x) => x.mitarbeiter_id === p.id && x.id !== s.id)
        const v = verfMap.get(`${p.id}|${s.datum}`)
        const r = pruefeZuweisung({ ...s, id: s.id }, eigene, { verfuegbar: v ? v.verfuegbar : null })
        const wochenMin = eigene.filter((x) => montagVon(x.datum) === woche).reduce((m, x) => m + arbeitsMinuten(x), 0)
        const imBereich = !s.bereich_id || !zuordnung.some((z) => z.user_id === p.id) || zuordnung.some((z) => z.user_id === p.id && z.bereich_id === s.bereich_id)
        const eingeteilt = eigene.some((x) => x.datum === s.datum)
        const interesse = !!s.id && interessen.some((i) => i.schicht_id === s.id && i.user_id === p.id)
        let status = v?.verfuegbar ? "frei ✔" : "frei"
        if (eingeteilt) status = "schon eingeteilt"
        if (v?.verfuegbar === false) status = "kann nicht"
        else if (r.sperren.length) status = "Konflikt"
        return { p, r, wochenMin, imBereich, status, interesse, gesperrt: r.sperren.length > 0 }
      })
      .sort(
        (a, b) =>
          Number(b.interesse) - Number(a.interesse) ||
          Number(a.gesperrt) - Number(b.gesperrt) ||
          Number(b.imBereich) - Number(a.imBereich) ||
          a.wochenMin - b.wochenMin
      )
  }, [s, personen, alle, verfMap, zuordnung, interessen])

  const gewaehlt = kandidaten.find((k) => k.p.id === s.mitarbeiter_id)
  const feld = "mt-1 block h-11 w-full min-w-0 appearance-none rounded-lg border bg-white px-3 text-base"

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-2 md:items-center" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto overflow-x-hidden rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold">
          {s.id ? "Schicht bearbeiten" : "Neue Schicht"} · {TAGE_LANG[wochentag(s.datum) - 1]}, {datumText(s.datum)}
        </h3>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="block min-w-0 text-sm font-medium text-neutral-600">Beginn<input type="time" className={feld} value={s.beginn} onChange={(e) => setS({ ...s, beginn: e.target.value })} /></label>
          <label className="block min-w-0 text-sm font-medium text-neutral-600">Ende<input type="time" className={feld} value={s.ende} onChange={(e) => setS({ ...s, ende: e.target.value })} /></label>
          <label className="block min-w-0 text-sm font-medium text-neutral-600">Datum<input type="date" className={feld} value={s.datum} onChange={(e) => setS({ ...s, datum: e.target.value })} /></label>
          <label className="block min-w-0 text-sm font-medium text-neutral-600">Bereich
            <select className={feld.replace("appearance-none ", "")} value={s.bereich_id} onChange={(e) => setS({ ...s, bereich_id: e.target.value })}>
              <option value="">–</option>
              {bereiche.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        </div>
        {s.ende <= s.beginn && <p className="mt-1 text-xs text-neutral-500">Endet am Folgetag (über Mitternacht).</p>}

        <p className="mt-5 text-sm font-medium text-neutral-600">Person</p>
        <p className="text-xs text-neutral-400">Sortiert: Interessenten, passende Personen, wenigste Stunden</p>
        <div className="mt-2 max-h-72 space-y-1 overflow-y-auto rounded-xl border p-1">
          <button
            onClick={() => setS({ ...s, mitarbeiter_id: "" })}
            className={`w-full rounded-lg px-3 py-2.5 text-left text-sm ${!s.mitarbeiter_id ? "bg-navy text-white" : "hover:bg-neutral-100"}`}
          >
            — niemand (unbesetzt)
          </button>
          {kandidaten.map((k) => (
            <button
              key={k.p.id}
              onClick={() => setS({ ...s, mitarbeiter_id: k.p.id, offen: false })}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${
                s.mitarbeiter_id === k.p.id ? "bg-navy text-white" : k.gesperrt ? "opacity-50 hover:bg-neutral-50" : "hover:bg-neutral-100"
              }`}
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-orange-soft text-xs font-semibold text-orange-strong">
                {k.p.full_name.trim().charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {k.interesse && "🙋 "}
                  {k.p.full_name}
                </span>
                <span className={`block text-xs ${s.mitarbeiter_id === k.p.id ? "text-white/70" : "text-neutral-500"}`}>
                  {formatStunden(k.wochenMin)} diese Woche
                  {k.p.stunden_grenze > 0 && ` · Grenze ${k.p.stunden_grenze} Std./${k.p.mitarbeiter_typ === "minijob" ? "Monat" : "Woche"}`}
                  {!k.imBereich && " · anderer Bereich"}
                </span>
              </span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  k.status === "kann nicht" || k.status === "Konflikt"
                    ? "bg-red-100 text-red-700"
                    : k.status === "schon eingeteilt"
                      ? "bg-amber-100 text-amber-800"
                      : k.status === "frei ✔"
                        ? "bg-green-100 text-green-700"
                        : "bg-neutral-100 text-neutral-600"
                }`}
              >
                {k.status === "frei ✔" ? "kann ✓" : k.status}
              </span>
            </button>
          ))}
        </div>
        {gewaehlt && (gewaehlt.r.sperren.length > 0 || gewaehlt.r.hinweise.length > 0) && (
          <div className="mt-2 space-y-1 text-xs">
            {gewaehlt.r.sperren.map((x) => <p key={x} className="text-red-700">⛔ {x}</p>)}
            {gewaehlt.r.hinweise.map((x) => <p key={x} className="text-orange-strong">⚠ {x}</p>)}
          </div>
        )}

        {!s.mitarbeiter_id && (
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.offen} onChange={(e) => setS({ ...s, offen: e.target.checked })} />
            Dem Team zur Übernahme anbieten (Push an alle im Bereich)
          </label>
        )}
        <label className="mt-4 block text-sm font-medium text-neutral-600">Notiz
          <input className={feld} maxLength={280} value={s.notiz} onChange={(e) => setS({ ...s, notiz: e.target.value })} />
        </label>

        <div className="mt-6 flex flex-wrap justify-between gap-2 border-t pt-4">
          <div>{s.id && <button className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-700" disabled={busy} onClick={() => onDelete(s.id!)}>Löschen</button>}</div>
          <div className="flex gap-2">
            <button className={knopf} onClick={onClose}>Abbrechen</button>
            <button
              className={knopfDunkel}
              disabled={busy || !!gewaehlt?.gesperrt}
              onClick={() => onSave({ ...s, mitarbeiter_id: s.mitarbeiter_id || null, bereich_id: s.bereich_id || null })}
            >
              Speichern
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Einstellungen

function EinstellungenAdmin({
  d,
  personen,
  bereiche,
  aktion,
  busy,
}: {
  d: any
  personen: Person[]
  bereiche: Bereich[]
  aktion: (b: object, ok: string) => Promise<boolean>
  busy: boolean
}) {
  const [e, setE] = useState<Einstellungen>({ ...d.einstellungen, frist_uhrzeit: hhmm(d.einstellungen.frist_uhrzeit) })
  const zuordnung: { user_id: string; bereich_id: string }[] = d.zuordnung
  const feld = "mt-1 block h-11 w-full min-w-0 appearance-none rounded-lg border bg-white px-3 text-base"

  return (
    <>
      <div className={karte}>
        <h3 className="text-lg font-bold">Frist & Erinnerungen</h3>
        <p className="text-sm text-neutral-600">
          Bis wann müssen Mitarbeitende ihre Verfügbarkeit für die <b>kommende Woche</b> eintragen?
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <label className="block min-w-0 text-sm font-medium text-neutral-600">Wochentag
            <select className={feld.replace("appearance-none ", "")} value={e.frist_wochentag} onChange={(x) => setE({ ...e, frist_wochentag: Number(x.target.value) })}>
              {TAGE_LANG.map((t, i) => <option key={t} value={i + 1}>{t}</option>)}
            </select>
          </label>
          <label className="block min-w-0 text-sm font-medium text-neutral-600">Uhrzeit
            <input type="time" className={feld} value={e.frist_uhrzeit} onChange={(x) => setE({ ...e, frist_uhrzeit: x.target.value })} />
          </label>
          <label className="block min-w-0 text-sm font-medium text-neutral-600">Erinnerung vor Frist (Std.)
            <input type="number" min={1} max={168} className={feld} value={e.erinnerung_stunden} onChange={(x) => setE({ ...e, erinnerung_stunden: Number(x.target.value) })} />
          </label>
          <label className="block min-w-0 text-sm font-medium text-neutral-600">Schicht-Erinnerung (Std. vorher, 0 = aus)
            <input type="number" min={0} max={168} className={feld} value={e.schicht_erinnerung_stunden} onChange={(x) => setE({ ...e, schicht_erinnerung_stunden: Number(x.target.value) })} />
          </label>
        </div>
        <p className="mt-3 text-xs text-neutral-500">
          Ablauf: {e.erinnerung_stunden} Std. vor Fristende bekommen alle, die noch nichts eingetragen haben, eine Push-Erinnerung.
          Nach Fristende bekommst du eine Liste, wer fehlt. Danach können Mitarbeitende die Woche nicht mehr ändern.
        </p>
        <button className={`${knopfDunkel} mt-4`} disabled={busy} onClick={() => aktion({ aktion: "einstellungen_speichern", ...e }, "Einstellungen gespeichert.")}>
          Speichern
        </button>
      </div>

      <div className={karte}>
        <h3 className="text-lg font-bold">Bereiche der Mitarbeitenden</h3>
        <p className="text-sm text-neutral-600">Steuert, wer bei offenen Schichten benachrichtigt wird.</p>
        <div className="mt-3 divide-y">
          {personen.map((p) => {
            const eigene = zuordnung.filter((z) => z.user_id === p.id).map((z) => z.bereich_id)
            return (
              <div key={p.id} className="flex items-center justify-between gap-2 py-2">
                <span className="text-sm">{p.full_name}</span>
                <span className="flex gap-2">
                  {bereiche.map((b) => {
                    const an = eigene.includes(b.id)
                    return (
                      <button
                        key={b.id}
                        disabled={busy}
                        className="rounded-lg border px-3 py-1 text-xs font-medium"
                        style={an ? { background: b.farbe, color: "white", borderColor: b.farbe } : {}}
                        onClick={() =>
                          aktion(
                            { aktion: "bereiche_setzen", user_id: p.id, bereich_ids: an ? eigene.filter((x) => x !== b.id) : [...eigene, b.id] },
                            "Gespeichert."
                          )
                        }
                      >
                        {b.name}
                      </button>
                    )
                  })}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
