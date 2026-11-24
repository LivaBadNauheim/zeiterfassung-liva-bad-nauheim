import "server-only"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import webpush from "web-push"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export function adminDb(): SupabaseClient {
  return createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false } })
}

export type Benutzer = { id: string; role: "admin" | "employee"; full_name: string }

export class Fehler extends Error {
  constructor(message: string, public status = 400) {
    super(message)
  }
}

/** Liest den Bearer-Token und liefert das aktive Profil – sonst Fehler 401/403. */
export async function benutzerAusRequest(req: Request, db: SupabaseClient): Promise<Benutzer> {
  const token = req.headers.get("authorization")?.replace("Bearer ", "")
  if (!token) throw new Fehler("Nicht angemeldet.", 401)
  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
  const { data, error } = await userClient.auth.getUser()
  if (error || !data.user) throw new Fehler("Session ungültig.", 401)
  const { data: p } = await db.from("profiles").select("id,role,full_name,is_active").eq("id", data.user.id).single()
  if (!p || !p.is_active) throw new Fehler("Kein aktives Profil.", 403)
  return { id: p.id, role: p.role, full_name: p.full_name }
}

export function fehlerAntwort(e: unknown) {
  if (e instanceof Fehler) return Response.json({ success: false, error: e.message }, { status: e.status })
  console.error("Dienstplan-Fehler:", e)
  return Response.json({ success: false, error: "Serverfehler." }, { status: 500 })
}

// ---------- Push ----------

let vapidGesetzt = false
function vapid() {
  if (vapidGesetzt) return true
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const priv = process.env.VAPID_PRIVATE_KEY
  if (!pub || !priv) {
    console.warn("VAPID-Keys fehlen – Push deaktiviert.")
    return false
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@liva-bad-nauheim.de", pub, priv)
  vapidGesetzt = true
  return true
}

export type Nachricht = { title: string; body: string; url?: string; tag?: string }

/** Schickt eine Push-Nachricht an alle Geraete der genannten Personen. Fehler werden nur geloggt. */
export async function pushAn(db: SupabaseClient, userIds: string[], n: Nachricht): Promise<number> {
  if (!userIds.length || !vapid()) return 0
  const { data: abos } = await db.from("push_abos").select("endpoint,p256dh,auth").in("user_id", userIds)
  let ok = 0
  await Promise.all(
    (abos ?? []).map(async (a) => {
      try {
        await webpush.sendNotification(
          { endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } },
          JSON.stringify({ url: "/", ...n }),
          { TTL: 60 * 60 * 24 }
        )
        ok++
      } catch (e: unknown) {
        const status = (e as { statusCode?: number }).statusCode
        // Abo abgelaufen / App deinstalliert -> aufraeumen
        if (status === 404 || status === 410) await db.from("push_abos").delete().eq("endpoint", a.endpoint)
        else console.error("Push fehlgeschlagen:", status, e)
      }
    })
  )
  return ok
}

export async function adminIds(db: SupabaseClient): Promise<string[]> {
  const { data } = await db.from("profiles").select("id").eq("role", "admin").eq("is_active", true)
  return (data ?? []).map((p) => p.id)
}

export async function mitarbeiterIds(db: SupabaseClient): Promise<string[]> {
  const { data } = await db.from("profiles").select("id").eq("role", "employee").eq("is_active", true)
  return (data ?? []).map((p) => p.id)
}

export function datumKurz(datum: string): string {
  const [y, m, d] = datum.split("-").map(Number)
  const tage = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"]
  return `${tage[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.`
}
