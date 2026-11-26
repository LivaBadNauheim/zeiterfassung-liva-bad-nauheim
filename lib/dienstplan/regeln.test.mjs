// Ausfuehren: npm test
import { test } from "node:test"
import assert from "node:assert/strict"
import { pruefeZuweisung, fristFuerWoche, offeneVerfuegbarkeitsWoche, montagVon, dauerMinuten } from "./regeln.ts"

const s = (datum, beginn, ende, id) => ({ id, datum, beginn, ende })

test("ueber Mitternacht", () => {
  assert.equal(dauerMinuten(s("2026-11-23", "22:00", "02:00")), 240)
})
test("Ueberschneidung sperrt, auch ueber Mitternacht", () => {
  const r = pruefeZuweisung(s("2026-11-24", "01:00", "05:00"), [s("2026-11-23", "22:00", "02:00")])
  assert.equal(r.sperren.length, 1)
})
test("Ruhezeit < 10 Std. sperrt", () => {
  const r = pruefeZuweisung(s("2026-11-24", "08:00", "14:00"), [s("2026-11-23", "17:00", "23:30")])
  assert.match(r.sperren[0], /Ruhezeit/)
})
test("Ruhezeit 10 Std. ok, geteilter Dienst ok, nahtlos ok", () => {
  assert.deepEqual(pruefeZuweisung(s("2026-11-24", "09:30", "14:00"), [s("2026-11-23", "17:00", "23:30")]).sperren, [])
  assert.deepEqual(pruefeZuweisung(s("2026-11-24", "18:00", "22:00"), [s("2026-11-24", "11:00", "14:00")]).sperren, [])
  assert.deepEqual(pruefeZuweisung(s("2026-11-24", "00:00", "03:00"), [s("2026-11-23", "20:00", "00:00")]).sperren, [])
})
test("Bearbeiten derselben Schicht kollidiert nicht mit sich selbst", () => {
  assert.deepEqual(pruefeZuweisung(s("2026-11-24", "10:00", "14:00", "a"), [s("2026-11-24", "11:00", "15:00", "a")]).sperren, [])
})
test("nicht verfuegbar sperrt, >10 Std. ist nur Hinweis", () => {
  assert.equal(pruefeZuweisung(s("2026-11-24", "10:00", "12:00"), [], { verfuegbar: false }).sperren.length, 1)
  const r = pruefeZuweisung(s("2026-11-24", "10:00", "22:00"), [])
  assert.equal(r.sperren.length, 0)
  assert.equal(r.hinweise.length, 1)
})
test("Stundengrenze als Hinweis", () => {
  const r = pruefeZuweisung(s("2026-11-24", "10:00", "14:00"), [], { grenze: { stunden: 43, bisherMin: 41 * 60, label: "Monatsgrenze" } })
  assert.match(r.hinweise[0], /Monatsgrenze/)
})
test("Frist: Do 18:00 der Vorwoche", () => {
  const e = { frist_wochentag: 4, frist_uhrzeit: "18:00:00" }
  assert.deepEqual(fristFuerWoche("2026-11-30", e), { datum: "2026-11-26", zeit: "18:00" })
  assert.equal(offeneVerfuegbarkeitsWoche({ datum: "2026-11-26", zeit: "17:59" }, e), "2026-11-30")
  assert.equal(offeneVerfuegbarkeitsWoche({ datum: "2026-11-26", zeit: "18:00" }, e), "2026-12-07")
  assert.equal(montagVon("2026-11-29"), "2026-11-23")
})

import { passtVerfuegbarkeit, schichtZeitenFuer } from "./regeln.ts"
test("Frueh/Spaet", () => {
  const e = {}
  assert.deepEqual(schichtZeitenFuer("2026-12-06", e).spaet, ["16:00", "22:00"])
  const nurSpaet = { verfuegbar: true, frueh: false, spaet: true }
  assert.equal(passtVerfuegbarkeit(s("2026-12-01", "17:00", "23:00"), nurSpaet, e), true)
  assert.equal(passtVerfuegbarkeit(s("2026-12-01", "08:30", "16:00"), nurSpaet, e), false)
  assert.equal(passtVerfuegbarkeit(s("2026-12-01", "12:00", "20:00"), nurSpaet, e), false)
  assert.equal(passtVerfuegbarkeit(s("2026-12-01", "12:00", "20:00"), { verfuegbar: true, frueh: true, spaet: true }, e), true)
  assert.equal(passtVerfuegbarkeit(s("2026-12-01", "10:00", "14:00"), { verfuegbar: true }, e), true)
  assert.equal(passtVerfuegbarkeit(s("2026-12-01", "10:00", "14:00"), { verfuegbar: false }, e), false)
  assert.equal(passtVerfuegbarkeit(s("2026-12-01", "10:00", "14:00"), null, e), null)
})
