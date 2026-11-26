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
      // Diagnose: Schluessel vorhanden? Abos gespeichert? Fehler beim Senden?
      const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
      if (!pub || !process.env.VAPID_PRIVATE_KEY) {
        return Response.json({ success: false, error: "VAPID-Schlüssel fehlen in Vercel (oder nach dem Eintragen nicht neu deployt)." })
      }
      if (body.clientKey && body.clientKey !== pub) {
        return Response.json({ success: false, error: "Die App nutzt einen anderen öffentlichen Schlüssel als der Server. Bitte neu deployen, App neu laden, Push aus- und wieder einschalten." })
      }
      const { count } = await db.from("push_abos").select("endpoint", { count: "exact", head: true }).eq("user_id", me.id)
      if (!count) return Response.json({ success: false, error: "Für dein Konto ist kein Gerät gespeichert. Bitte „Aus“ und dann wieder „Aktivieren“ tippen." })
      const fehler: string[] = []
      const n = await pushAn(db, [me.id], { title: "Liva Dienstplan", body: "Push funktioniert ✔", tag: "test" }, fehler)
      if (!n) return Response.json({ success: false, error: `Senden fehlgeschlagen (${count} Gerät(e)): ${fehler.join(" | ") || "unbekannt"}` })
      return Response.json({ success: true, gesendet: n, geraete: count })
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
