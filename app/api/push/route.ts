import { adminDb, benutzerAusRequest, Fehler, fehlerAntwort, pushAn } from "@/lib/dienstplan/server"

// POST { subscription } -> Geraet fuer Push anmelden
// POST { test: true }   -> Test-Nachricht an alle eigenen Geraete
// DELETE { endpoint }   -> Geraet abmelden
export async function POST(req: Request) {
  try {
    const db = adminDb()
    const me = await benutzerAusRequest(req, db)
    const body = await req.json()
    if (body.test) {
      const n = await pushAn(db, [me.id], { title: "Liva Dienstplan", body: "Push funktioniert ✔", tag: "test" })
      return Response.json({ success: true, gesendet: n })
    }
    const s = body.subscription
    if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth) throw new Fehler("Ungültiges Abo.")
    const { error } = await db
      .from("push_abos")
      .upsert({ endpoint: s.endpoint, user_id: me.id, p256dh: s.keys.p256dh, auth: s.keys.auth })
    if (error) throw new Fehler(error.message, 500)
    return Response.json({ success: true })
  } catch (e) {
    return fehlerAntwort(e)
  }
}

export async function DELETE(req: Request) {
  try {
    const db = adminDb()
    const me = await benutzerAusRequest(req, db)
    const { endpoint } = await req.json()
    await db.from("push_abos").delete().eq("endpoint", endpoint).eq("user_id", me.id)
    return Response.json({ success: true })
  } catch (e) {
    return fehlerAntwort(e)
  }
}
