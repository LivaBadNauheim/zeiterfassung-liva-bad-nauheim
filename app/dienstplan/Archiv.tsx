"use client"

import { useState } from "react"
import { supabase } from "@/lib/supabase"

/** Archiv-Export vor dem Zuruecksetzen (Excel + Vollsicherung). */
export function ArchivKarte() {
  const [busy, setBusy] = useState("")
  const [meldung, setMeldung] = useState("")

  async function laden(format: "xlsx" | "json") {
    setBusy(format)
    setMeldung("")
    try {
      const { data } = await supabase.auth.getSession()
      const res = await fetch(`/api/admin/archiv?format=${format}`, {
        headers: { Authorization: `Bearer ${data.session?.access_token}` },
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `Fehler ${res.status}`)
      }
      const blob = await res.blob()
      const name = res.headers.get("Content-Disposition")?.match(/filename="(.+)"/)?.[1] ?? `liva-archiv.${format}`
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = name
      a.click()
      URL.revokeObjectURL(url)
      setMeldung(`✔ ${name} heruntergeladen.`)
    } catch (e) {
      setMeldung("✖ " + (e as Error).message)
    } finally {
      setBusy("")
    }
  }

  return (
    <div className="rounded-2xl bg-white p-6 shadow">
      <h2 className="text-xl font-bold">Archiv (Jahresabschluss)</h2>
      <p className="mt-1 text-sm text-neutral-600">
        Sichert <b>alle</b> Daten: Arbeitszeiten, Monatssummen, Mitarbeiter, Dienstplan und Verfügbarkeiten. Beide Dateien auf zwei
        externe Speicher legen (z.&nbsp;B. USB-Stick und Festplatte) und für Prüfungen aufbewahren.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button disabled={!!busy} onClick={() => laden("xlsx")} className="rounded-lg bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {busy === "xlsx" ? "Erstelle …" : "📊 Archiv als Excel"}
        </button>
        <button disabled={!!busy} onClick={() => laden("json")} className="rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50">
          {busy === "json" ? "Erstelle …" : "💾 Vollsicherung (JSON)"}
        </button>
      </div>
      {meldung && <p className={`mt-3 text-sm ${meldung.startsWith("✖") ? "text-red-700" : "text-green-700"}`}>{meldung}</p>}
    </div>
  )
}
