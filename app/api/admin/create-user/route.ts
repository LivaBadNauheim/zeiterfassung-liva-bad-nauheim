import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

function isValidInternalLogin(email: string) {
  const normalized = email.toLowerCase().trim()

  /*
    Erlaubtes Format:
    vorname.nachname@zeiterfassung.local

    Erlaubt:
    - Kleinbuchstaben a-z
    - deutsche Umschreibung ae, oe, ue
    - Bindestrich im Vornamen oder Nachnamen für Doppelnamen
    - genau ein Punkt zwischen Vorname und Nachname

    Beispiele:
    max.mustermann@zeiterfassung.local
    lukas-yong.friedel@zeiterfassung.local
    albina-aliu.krasniqui@zeiterfassung.local
  */
  const regex = /^[a-z]+(?:-[a-z]+)*\.[a-z]+(?:-[a-z]+)*@zeiterfassung\.local$/

  return regex.test(normalized)
}

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

    const fullName = body.fullName?.toString().trim()
    const email = body.email?.toString().trim().toLowerCase()
    const password = body.password?.toString()
    const role = body.role?.toString() || "employee"

    if (!fullName || !email || !password) {
      return Response.json(
        {
          success: false,
          error: "Name, Login-Adresse und Passwort sind erforderlich.",
        },
        { status: 400 }
      )
    }

    if (!isValidInternalLogin(email)) {
      return Response.json(
        {
          success: false,
          error:
            "Login-Adresse muss dem Schema vorname.nachname@zeiterfassung.local entsprechen. Beispiel: max.mustermann@zeiterfassung.local",
        },
        { status: 400 }
      )
    }

    if (!["employee", "admin"].includes(role)) {
      return Response.json(
        { success: false, error: "Ungültige Rolle." },
        { status: 400 }
      )
    }

    if (password.length < 8) {
      return Response.json(
        { success: false, error: "Passwort muss mindestens 8 Zeichen haben." },
        { status: 400 }
      )
    }

    const { data: existingProfiles, error: existingProfileError } =
      await adminClient
        .from("profiles")
        .select("id")
        .eq("email", email)
        .limit(1)

    if (existingProfileError) {
      return Response.json(
        {
          success: false,
          error: "Login-Adresse konnte nicht geprüft werden.",
        },
        { status: 500 }
      )
    }

    if (existingProfiles && existingProfiles.length > 0) {
      return Response.json(
        {
          success: false,
          error: "Diese Login-Adresse ist bereits vergeben.",
        },
        { status: 400 }
      )
    }

    const { data: authData, error: authError } =
      await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      })

    if (authError || !authData.user) {
      return Response.json(
        {
          success: false,
          error: authError?.message || "User konnte nicht erstellt werden.",
        },
        { status: 500 }
      )
    }

    const { error: insertProfileError } = await adminClient
      .from("profiles")
      .insert({
        id: authData.user.id,
        full_name: fullName,
        email,
        role,
        is_active: true,
      })

    if (insertProfileError) {
      await adminClient.auth.admin.deleteUser(authData.user.id)

      return Response.json(
        { success: false, error: insertProfileError.message },
        { status: 500 }
      )
    }

    return Response.json({
      success: true,
      user: {
        id: authData.user.id,
        full_name: fullName,
        email,
        role,
        is_active: true,
      },
    })
  } catch (error) {
    console.error("Create user error:", error)

    return Response.json(
      { success: false, error: "Serverfehler." },
      { status: 500 }
    )
  }
}