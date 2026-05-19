import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function POST(req: Request) {
  try {
    const authorization = req.headers.get("authorization")

    if (!authorization) {
      return Response.json(
        { success: false, error: "Nicht angemeldet." },
        { status: 401 }
      )
    }

    const token = authorization.replace("Bearer ", "")

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    })

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser()

    if (userError || !user) {
      return Response.json(
        { success: false, error: "Session ungültig." },
        { status: 401 }
      )
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey)

    const { data: adminProfile, error: profileError } = await adminClient
      .from("profiles")
      .select("role,is_active")
      .eq("id", user.id)
      .single()

    if (profileError || !adminProfile) {
      return Response.json(
        { success: false, error: "Admin-Profil nicht gefunden." },
        { status: 403 }
      )
    }

    if (adminProfile.role !== "admin" || !adminProfile.is_active) {
      return Response.json(
        { success: false, error: "Keine Admin-Berechtigung." },
        { status: 403 }
      )
    }

    const body = await req.json()

    const userId = body.userId?.toString()
    const isActive = Boolean(body.isActive)

    if (!userId) {
      return Response.json(
        { success: false, error: "Mitarbeiter fehlt." },
        { status: 400 }
      )
    }

    if (userId === user.id && !isActive) {
      return Response.json(
        { success: false, error: "Du kannst deinen eigenen Admin-Zugang nicht deaktivieren." },
        { status: 400 }
      )
    }

    const { error: updateError } = await adminClient
      .from("profiles")
      .update({
        is_active: isActive,
      })
      .eq("id", userId)

    if (updateError) {
      return Response.json(
        { success: false, error: updateError.message },
        { status: 500 }
      )
    }

    return Response.json({ success: true })
  } catch (error) {
    console.error("Set active error:", error)

    return Response.json(
      { success: false, error: "Serverfehler." },
      { status: 500 }
    )
  }
}