"use client"

import { useEffect, useMemo, useState } from "react"
import * as XLSX from "xlsx"
import { supabase } from "@/lib/supabase"

type Profile = {
  id: string
  full_name: string
  email: string
  role: "employee" | "admin"
  is_active: boolean
}

type TimeEntry = {
  id?: string
  user_id: string
  work_date: string
  entry_type: "work" | "vacation" | "sick" | "day_off" | "holiday"
  start_time: string | null
  end_time: string | null
  break_minutes: number
  note: string | null
}

type EmployeeView = "dashboard" | "time" | "overview" | "export"
type AdminView =
  | "dashboard"
  | "edit-times"
  | "create-user"
  | "reset-password"
  | "manage-users"
  | "export"

const entryTypeLabels: Record<TimeEntry["entry_type"], string> = {
  work: "Arbeit",
  vacation: "Urlaub",
  sick: "Krank",
  day_off: "Frei",
  holiday: "Feiertag",
}

function formatDate(date: Date) {
  // WICHTIG: lokale Zeit verwenden, nicht toISOString() (UTC).
  // toISOString() verschiebt lokale Mitternacht in DE (UTC+1/+2) auf den Vortag
  // und führte dazu, dass gespeicherte Daten und Export-Zeiträume um einen Tag
  // daneben lagen.
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

// Liefert das aktuelle Datum/die aktuelle Uhrzeit fest bezogen auf die deutsche
// Zeitzone (Europe/Berlin) – unabhängig davon, wie das Gerät des Nutzers
// eingestellt ist. So wird "heute" / "aktuelle Woche" / "aktueller Monat" immer
// nach deutscher Zeit bestimmt, auch wenn jemand aus dem Urlaub in einer anderen
// Zeitzone Zeiten bearbeitet.
//
// Hinweis: Der zurückgegebene Date-Wert wird nur über seine Kalenderfelder
// (Jahr/Monat/Tag/Wochentag) genutzt, nie über seinen absoluten Zeitpunkt.
function berlinNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date())

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0"

  const hour = Number(get("hour")) % 24 // Absicherung gegen "24" (iOS-Eigenheit)

  return new Date(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    hour,
    Number(get("minute")),
    Number(get("second"))
  )
}

function getMonday(date: Date) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  d.setDate(diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function addDays(date: Date, days: number) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

function minutesFromTime(time: string | null) {
  if (!time) return 0
  const [h, m] = time.split(":").map(Number)
  return h * 60 + m
}

function calculateMinutes(entry: TimeEntry) {
  if (entry.entry_type !== "work") return 0
  if (!entry.start_time || !entry.end_time) return 0

  const start = minutesFromTime(entry.start_time)
  let end = minutesFromTime(entry.end_time)

  // Arbeitszeiten über Mitternacht korrekt berechnen.
  // Beispiel: 17:00 bis 00:00 = 7:00 Std.
  // Beispiel: 22:00 bis 02:00 = 4:00 Std.
  if (end <= start) {
    end += 24 * 60
  }

  return Math.max(0, end - start - (entry.break_minutes || 0))
}

function formatHours(minutes: number) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h}:${m.toString().padStart(2, "0")} Std.`
}

function getMonthRangeFromDate(date: Date) {
  const start = new Date(date.getFullYear(), date.getMonth(), 1)
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0)

  return {
    start: formatDate(start),
    end: formatDate(end),
  }
}

function getMonthRangeFromInput(monthInput: string) {
  const [year, month] = monthInput.split("-").map(Number)

  const start = new Date(year, month - 1, 1)
  const end = new Date(year, month, 0)

  return {
    start: formatDate(start),
    end: formatDate(end),
  }
}

function getCurrentMonthInput() {
  const now = berlinNow()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
}

function todayDateString() {
  return formatDate(berlinNow())
}

function addMonths(date: Date, months: number) {
  const d = new Date(date)
  d.setDate(1)
  d.setMonth(d.getMonth() + months)
  d.setHours(0, 0, 0, 0)
  return d
}

type PeriodMode = "week" | "month"

// Liefert den Datumsbereich (start/end als "YYYY-MM-DD") für die Anzeige,
// je nachdem ob Wochen- oder Monatsansicht aktiv ist.
function getPeriodRange(anchor: Date, mode: PeriodMode) {
  if (mode === "month") {
    return getMonthRangeFromDate(anchor)
  }

  const monday = getMonday(anchor)
  return {
    start: formatDate(monday),
    end: formatDate(addDays(monday, 6)),
  }
}

// Erzeugt die Liste der anzuzeigenden Tage für den aktuellen Zeitraum.
function getPeriodDays(anchor: Date, mode: PeriodMode) {
  if (mode === "month") {
    const year = anchor.getFullYear()
    const month = anchor.getMonth()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    return Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1))
  }

  const monday = getMonday(anchor)
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i))
}

function getPeriodLabel(anchor: Date, mode: PeriodMode) {
  if (mode === "month") {
    return anchor.toLocaleDateString("de-DE", { month: "long", year: "numeric" })
  }

  const days = getPeriodDays(anchor, "week")
  return `${formatDate(days[0])} bis ${formatDate(days[6])}`
}

function excelDownload(filename: string, rows: string[][]) {
  const worksheet = XLSX.utils.aoa_to_sheet(rows)

  worksheet["!cols"] = [
    { wch: 24 },
    { wch: 34 },
    { wch: 14 },
    { wch: 14 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
    { wch: 30 },
  ]

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, "Zeiterfassung")

  const finalFilename = filename.endsWith(".xlsx")
    ? filename
    : `${filename}.xlsx`

  XLSX.writeFile(workbook, finalFilename)
}

function getEmptyEntry(userId: string, date: string): TimeEntry {
  // Standard ist "Frei" mit leeren Feldern. Erst wenn der Nutzer bewusst
  // "Arbeit" wählt und Zeiten einträgt, zählt der Tag als gearbeitet.
  // Das verhindert versehentliches Speichern von 09-17-Standardzeiten.
  return {
    user_id: userId,
    work_date: date,
    entry_type: "day_off",
    start_time: null,
    end_time: null,
    break_minutes: 0,
    note: null,
  }
}

function getEntryStatus(entry: TimeEntry, dirtyDates: Set<string>) {
  if (dirtyDates.has(entry.work_date)) return "dirty"
  if (entry.id) return "saved"
  return "new"
}

function normalizeEntryForSave(entry: TimeEntry) {
  // Arbeit zählt nur, wenn Start und Ende gesetzt sind. Ist "Arbeit" gewählt,
  // aber ein Zeitfeld leer, wird der Tag als "Frei" (nicht gearbeitet) gespeichert.
  const hasTimes = Boolean(entry.start_time) && Boolean(entry.end_time)
  const effectiveType = entry.entry_type === "work" && !hasTimes ? "day_off" : entry.entry_type
  const isWork = effectiveType === "work"

  return {
    user_id: entry.user_id,
    work_date: entry.work_date,
    entry_type: effectiveType,
    start_time: isWork ? entry.start_time || null : null,
    end_time: isWork ? entry.end_time || null : null,
    break_minutes: isWork ? Number(entry.break_minutes || 0) : 0,
    note: entry.note || null,
  }
}

function LoginScreen({ onLogin }: { onLogin: () => Promise<void> }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginError, setLoginError] = useState("")

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoginLoading(true)
    setLoginError("")

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      setLoginError("Login fehlgeschlagen. Bitte Zugangsdaten prüfen.")
      setLoginLoading(false)
      return
    }

    setLoginLoading(false)
    await onLogin()
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-100 p-4">
      <form
        onSubmit={handleLogin}
        className="w-full max-w-md rounded-2xl bg-white p-8 shadow"
      >
        <h1 className="text-2xl font-bold">Zeiterfassung</h1>
        <p className="mt-2 text-sm text-neutral-600">
          Melde dich mit deinem internen Zugang an.
        </p>

        <div className="mt-6 space-y-4">
          <div>
            <label className="text-sm font-medium">Login-Adresse</label>
            <input
              className="mt-1 w-full rounded-lg border px-3 py-2"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="vorname.nachname@zeiterfassung.local"
            />
          </div>

          <div>
            <label className="text-sm font-medium">Passwort</label>
            <input
              className="mt-1 w-full rounded-lg border px-3 py-2"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              placeholder="Passwort"
            />
          </div>

          {loginError && (
            <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
              {loginError}
            </p>
          )}

          <button
            disabled={loginLoading}
            className="w-full rounded-lg bg-black px-4 py-2 font-medium text-white disabled:opacity-50"
          >
            {loginLoading ? "Anmelden..." : "Anmelden"}
          </button>
        </div>
      </form>
    </main>
  )
}

function StatCard({
  title,
  value,
  subtitle,
}: {
  title: string
  value: string | number
  subtitle?: string
}) {
  return (
    <div className="rounded-2xl bg-white p-5 shadow">
      <p className="text-sm text-neutral-500">{title}</p>
      <p className="mt-2 text-2xl font-bold">{value}</p>
      {subtitle && <p className="mt-1 text-xs text-neutral-500">{subtitle}</p>}
    </div>
  )
}

function Sidebar({
  profile,
  activeView,
  setActiveView,
  onLogout,
  darkMode,
  toggleDarkMode,
}: {
  profile: Profile
  activeView: string
  setActiveView: (view: any) => void
  onLogout: () => Promise<void>
  darkMode: boolean
  toggleDarkMode: () => void
}) {
  const adminItems: { key: AdminView; label: string }[] = [
    { key: "dashboard", label: "Dashboard" },
    { key: "edit-times", label: "Zeiten bearbeiten" },
    { key: "create-user", label: "Mitarbeiter anlegen" },
    { key: "reset-password", label: "Passwort zurücksetzen" },
    { key: "manage-users", label: "Mitarbeiter verwalten" },
    { key: "export", label: "Export" },
  ]

  const employeeItems: { key: EmployeeView; label: string }[] = [
    { key: "dashboard", label: "Dashboard" },
    { key: "time", label: "Zeiten erfassen" },
    { key: "overview", label: "Meine Übersicht" },
    { key: "export", label: "Export" },
  ]

  const items = profile.role === "admin" ? adminItems : employeeItems

  return (
    <aside className="w-full rounded-2xl bg-white p-4 shadow lg:min-h-[calc(100vh-2rem)] lg:w-72">
      <div className="mb-6">
        <h1 className="text-xl font-bold">Zeiterfassung</h1>
        <p className="mt-1 text-sm text-neutral-600">{profile.full_name}</p>
        <p className="text-xs text-neutral-400">{profile.role}</p>
      </div>

      <nav className="flex flex-col gap-2">
        {items.map((item) => (
          <button
            key={item.key}
            onClick={() => setActiveView(item.key)}
            className={
              activeView === item.key
                ? "rounded-xl bg-black px-4 py-3 text-left text-sm font-medium text-white"
                : "rounded-xl px-4 py-3 text-left text-sm font-medium text-neutral-700 hover:bg-neutral-100"
            }
          >
            {item.label}
          </button>
        ))}

        <button
          onClick={toggleDarkMode}
          className="mt-4 rounded-xl border px-4 py-3 text-left text-sm font-medium text-neutral-700 hover:bg-neutral-100"
        >
          {darkMode ? "☀️ Lightmode" : "🌙 Darkmode"}
        </button>

        <button
          onClick={onLogout}
          className="mt-2 rounded-xl border border-red-200 px-4 py-3 text-left text-sm font-medium text-red-700 hover:bg-red-50"
        >
          Abmelden
        </button>
      </nav>
    </aside>
  )
}

function TimeEntryTable({
  userId,
  anchorDate,
  setAnchorDate,
  periodMode,
  setPeriodMode,
  entries,
  dirtyDates,
  savingDate,
  onChangeEntry,
  onSaveEntry,
  onSaveAll,
  isSavingAll,
  title,
}: {
  userId: string
  anchorDate: Date
  setAnchorDate: (date: Date) => void
  periodMode: PeriodMode
  setPeriodMode: (mode: PeriodMode) => void
  entries: TimeEntry[]
  dirtyDates: Set<string>
  savingDate: string | null
  onChangeEntry: (date: string, changes: Partial<TimeEntry>) => void
  onSaveEntry: (date: string) => void
  onSaveAll: () => void
  isSavingAll: boolean
  title: string
}) {
  const days = useMemo(() => {
    return getPeriodDays(anchorDate, periodMode)
  }, [anchorDate, periodMode])

  const periodLabel = getPeriodLabel(anchorDate, periodMode)
  const today = todayDateString()

  function jumpToDate(dateValue: string) {
    if (!dateValue) return
    setAnchorDate(new Date(`${dateValue}T12:00:00`))
  }

  function goPrevious() {
    setAnchorDate(periodMode === "month" ? addMonths(anchorDate, -1) : addDays(getMonday(anchorDate), -7))
  }

  function goNext() {
    setAnchorDate(periodMode === "month" ? addMonths(anchorDate, 1) : addDays(getMonday(anchorDate), 7))
  }

  function getEntryForDate(date: string) {
    return entries.find((entry) => entry.work_date === date) || getEmptyEntry(userId, date)
  }

  // Summe und Anzahl ungespeicherter Änderungen nur für den angezeigten Zeitraum.
  const visibleDates = days.map((day) => formatDate(day))
  const periodMinutes = visibleDates.reduce(
    (sum, date) => sum + calculateMinutes(getEntryForDate(date)),
    0
  )
  const dirtyInPeriod = visibleDates.filter((date) => dirtyDates.has(date)).length

  return (
    <div className="rounded-2xl bg-white p-6 shadow">
      <div className="mb-6 flex flex-col justify-between gap-4 xl:flex-row xl:items-center">
        <div>
          <h2 className="text-xl font-bold">{title}</h2>
          <p className="text-sm text-neutral-600">
            {periodLabel} · Summe: {formatHours(periodMinutes)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Umschalter Woche / Monat */}
          <div className="flex rounded-lg border p-1 text-sm font-medium">
            <button
              onClick={() => setPeriodMode("week")}
              className={
                periodMode === "week"
                  ? "rounded-md bg-black px-3 py-1.5 text-white"
                  : "rounded-md px-3 py-1.5 text-neutral-600"
              }
            >
              Woche
            </button>
            <button
              onClick={() => setPeriodMode("month")}
              className={
                periodMode === "month"
                  ? "rounded-md bg-black px-3 py-1.5 text-white"
                  : "rounded-md px-3 py-1.5 text-neutral-600"
              }
            >
              Monat
            </button>
          </div>

          <label className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium">
            <span>📅</span>
            <input
              type="date"
              onChange={(e) => jumpToDate(e.target.value)}
              className="bg-transparent outline-none"
              title="Datum auswählen"
            />
          </label>

          <button onClick={goPrevious} className="rounded-lg border px-4 py-2">
            {periodMode === "month" ? "Voriger Monat" : "Vorherige Woche"}
          </button>
          <button
            onClick={() => setAnchorDate(berlinNow())}
            className="rounded-lg border px-4 py-2"
          >
            {periodMode === "month" ? "Aktueller Monat" : "Heute"}
          </button>
          <button onClick={goNext} className="rounded-lg border px-4 py-2">
            {periodMode === "month" ? "Nächster Monat" : "Nächste Woche"}
          </button>
        </div>
      </div>

      {dirtyInPeriod > 0 && (
        <div className="mb-4 flex flex-col items-start justify-between gap-2 rounded-xl border border-yellow-200 bg-yellow-50 p-3 sm:flex-row sm:items-center">
          <span className="text-sm font-medium text-yellow-800">
            {dirtyInPeriod} ungespeicherte Änderung{dirtyInPeriod === 1 ? "" : "en"} in diesem Zeitraum
          </span>
          <button
            onClick={onSaveAll}
            disabled={isSavingAll}
            className="rounded-lg bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {isSavingAll ? "Speichert..." : "Alle speichern"}
          </button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] border-collapse text-sm">
          <thead>
            <tr className="border-b bg-neutral-50 text-left">
              <th className="p-3">Tag</th>
              <th className="p-3">Typ</th>
              <th className="p-3">Beginn</th>
              <th className="p-3">Ende</th>
              <th className="p-3">Pause</th>
              <th className="p-3">Gesamt</th>
              <th className="p-3">Notiz</th>
              <th className="p-3">Status</th>
              <th className="p-3">Aktion</th>
            </tr>
          </thead>

          <tbody>
            {days.map((day, index) => {
              const date = formatDate(day)
              const entry = getEntryForDate(date)
              const isWork = entry.entry_type === "work"
              const status = getEntryStatus(entry, dirtyDates)
              const isSaving = savingDate === date

              const weekday = day.getDay()
              const isWeekend = weekday === 0 || weekday === 6
              const isToday = date === today
              // Im Monat: dezenter Trenner zu Beginn jeder neuen Woche (Montag).
              const isWeekStart = periodMode === "month" && index > 0 && weekday === 1

              const rowClasses = [
                "border-b",
                isWeekStart ? "border-t-2 border-t-neutral-200" : "",
                isToday ? "bg-blue-50" : isWeekend ? "bg-neutral-50/60" : "",
              ]
                .filter(Boolean)
                .join(" ")

              return (
                <tr key={date} className={rowClasses}>
                  <td className="p-3 font-medium">
                    {day.toLocaleDateString("de-DE", {
                      weekday: "long",
                      day: "2-digit",
                      month: "2-digit",
                    })}
                    {isToday && (
                      <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                        Heute
                      </span>
                    )}
                  </td>

                  <td className="p-3">
                    <select
                      className="w-full rounded-lg border px-2 py-2"
                      value={entry.entry_type}
                      onChange={(e) =>
                        onChangeEntry(date, {
                          entry_type: e.target.value as TimeEntry["entry_type"],
                        })
                      }
                    >
                      <option value="work">Arbeit</option>
                      <option value="vacation">Urlaub</option>
                      <option value="sick">Krank</option>
                      <option value="day_off">Frei</option>
                      <option value="holiday">Feiertag</option>
                    </select>
                  </td>

                  <td className="p-3">
                    <input
                      disabled={!isWork}
                      type="time"
                      className="w-full rounded-lg border px-2 py-2 disabled:bg-neutral-100"
                      value={entry.start_time || ""}
                      onChange={(e) => onChangeEntry(date, { start_time: e.target.value })}
                    />
                  </td>

                  <td className="p-3">
                    <input
                      disabled={!isWork}
                      type="time"
                      className="w-full rounded-lg border px-2 py-2 disabled:bg-neutral-100"
                      value={entry.end_time || ""}
                      onChange={(e) => onChangeEntry(date, { end_time: e.target.value })}
                    />
                  </td>

                  <td className="p-3">
                    <input
                      disabled={!isWork}
                      type="number"
                      min={0}
                      step={5}
                      className="w-full rounded-lg border px-2 py-2 disabled:bg-neutral-100"
                      value={entry.break_minutes}
                      onChange={(e) =>
                        onChangeEntry(date, {
                          break_minutes: Number(e.target.value),
                        })
                      }
                    />
                  </td>

                  <td className="p-3 font-medium">{formatHours(calculateMinutes(entry))}</td>

                  <td className="p-3">
                    <input
                      className="w-full rounded-lg border px-2 py-2"
                      value={entry.note || ""}
                      onChange={(e) => onChangeEntry(date, { note: e.target.value })}
                      placeholder="Optional"
                    />
                  </td>

                  <td className="p-3">
                    {status === "dirty" && (
                      <span className="rounded-full bg-yellow-100 px-3 py-1 text-xs font-medium text-yellow-700">
                        Ungespeichert
                      </span>
                    )}
                    {status === "saved" && (
                      <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-700">
                        Gespeichert
                      </span>
                    )}
                    {status === "new" && (
                      <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
                        Neu
                      </span>
                    )}
                  </td>

                  <td className="p-3">
                    <button
                      onClick={() => onSaveEntry(date)}
                      disabled={isSaving || status === "saved"}
                      className={
                        status === "saved"
                          ? "rounded-lg border border-green-300 px-4 py-2 font-medium text-green-700 disabled:opacity-70"
                          : "rounded-lg bg-black px-4 py-2 font-medium text-white disabled:opacity-50"
                      }
                    >
                      {isSaving ? "Speichert..." : status === "saved" ? "Bearbeiten" : "Speichern"}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function Home() {
  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [darkMode, setDarkMode] = useState(false)

  const [employeeView, setEmployeeView] = useState<EmployeeView>("dashboard")
  const [adminView, setAdminView] = useState<AdminView>("dashboard")

  const [profiles, setProfiles] = useState<Profile[]>([])
  const [allEntriesUntilToday, setAllEntriesUntilToday] = useState<TimeEntry[]>([])

  const [employeeWeek, setEmployeeWeek] = useState(getMonday(berlinNow()))
  const [employeePeriodMode, setEmployeePeriodMode] = useState<PeriodMode>("week")
  const [employeeEntries, setEmployeeEntries] = useState<TimeEntry[]>([])
  const [employeeMonthEntries, setEmployeeMonthEntries] = useState<TimeEntry[]>([])
  const [employeeDirtyDates, setEmployeeDirtyDates] = useState<Set<string>>(new Set())
  const [employeeSavingDate, setEmployeeSavingDate] = useState<string | null>(null)
  const [employeeSavingAll, setEmployeeSavingAll] = useState(false)

  const [adminSelectedUserId, setAdminSelectedUserId] = useState("")
  const [adminWeek, setAdminWeek] = useState(getMonday(berlinNow()))
  const [adminPeriodMode, setAdminPeriodMode] = useState<PeriodMode>("week")
  const [adminEntries, setAdminEntries] = useState<TimeEntry[]>([])
  const [adminMonthEntries, setAdminMonthEntries] = useState<TimeEntry[]>([])
  const [adminDirtyDates, setAdminDirtyDates] = useState<Set<string>>(new Set())
  const [adminSavingDate, setAdminSavingDate] = useState<string | null>(null)
  const [adminSavingAll, setAdminSavingAll] = useState(false)

  const [createFullName, setCreateFullName] = useState("")
  const [createEmail, setCreateEmail] = useState("")
  const [createPassword, setCreatePassword] = useState("")
  const [createRole, setCreateRole] = useState<"employee" | "admin">("employee")
  const [createUserLoading, setCreateUserLoading] = useState(false)

  const [resetPasswordUserId, setResetPasswordUserId] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [resetPasswordLoading, setResetPasswordLoading] = useState(false)

  const [activeLoadingId, setActiveLoadingId] = useState<string | null>(null)

  const [exportFrom, setExportFrom] = useState(getMonthRangeFromDate(berlinNow()).start)
  const [exportTo, setExportTo] = useState(getMonthRangeFromDate(berlinNow()).end)
  const [exportSelectedUserIds, setExportSelectedUserIds] = useState<string[]>([])

  const selectedAdminProfile = profiles.find((p) => p.id === adminSelectedUserId)

  useEffect(() => {
    init()

    const savedTheme = localStorage.getItem("zeiterfassung-theme")
    if (savedTheme === "dark") {
      setDarkMode(true)
      document.documentElement.classList.add("dark")
    }
  }, [])

  useEffect(() => {
    if (profile) {
      fetchProfiles()
      fetchAllEntriesUntilToday()
    }
  }, [profile])

  useEffect(() => {
    if (profile) {
      fetchEmployeeEntries()
      fetchEmployeeMonthEntries()
    }
  }, [profile, employeeWeek, employeePeriodMode])

  useEffect(() => {
    if (profile?.role === "admin" && adminSelectedUserId) {
      fetchAdminEntries()
      fetchAdminMonthEntries()
    }
  }, [profile, adminSelectedUserId, adminWeek, adminPeriodMode])

  async function init() {
    setLoading(true)

    const { data } = await supabase.auth.getUser()

    if (!data.user) {
      setProfile(null)
      setLoading(false)
      return
    }

    const { data: profileData } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", data.user.id)
      .single()

    if (!profileData || !profileData.is_active) {
      await supabase.auth.signOut()
      setProfile(null)
      setLoading(false)
      return
    }

    setProfile(profileData)
    setLoading(false)
  }

  async function handleLogout() {
    await supabase.auth.signOut()
    setProfile(null)
  }

  function toggleDarkMode() {
    setDarkMode((current) => {
      const next = !current

      if (next) {
        localStorage.setItem("zeiterfassung-theme", "dark")
        document.documentElement.classList.add("dark")
      } else {
        localStorage.setItem("zeiterfassung-theme", "light")
        document.documentElement.classList.remove("dark")
      }

      return next
    })
  }

  async function fetchProfiles() {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .order("full_name", { ascending: true })

    if (!error) {
      setProfiles(data || [])
      if (!adminSelectedUserId && data && data.length > 0) {
        setAdminSelectedUserId(data[0].id)
      }
      if (exportSelectedUserIds.length === 0 && data) {
        setExportSelectedUserIds(data.map((p) => p.id))
      }
    }
  }

  async function fetchAllEntriesUntilToday() {
    const { data, error } = await supabase
      .from("time_entries")
      .select("*")
      .lte("work_date", todayDateString())

    if (!error) setAllEntriesUntilToday(data || [])
  }

  async function fetchEmployeeEntries() {
    if (!profile) return

    const { start, end } = getPeriodRange(employeeWeek, employeePeriodMode)

    const { data, error } = await supabase
      .from("time_entries")
      .select("*")
      .eq("user_id", profile.id)
      .gte("work_date", start)
      .lte("work_date", end)
      .order("work_date", { ascending: true })

    if (!error) {
      setEmployeeEntries((current) => {
        const dirty = employeeDirtyDates
        const unsaved = current.filter((entry) => dirty.has(entry.work_date))
        const fresh = data || []
        const freshWithoutDirty = fresh.filter((entry) => !dirty.has(entry.work_date))
        return [...freshWithoutDirty, ...unsaved].sort((a, b) => a.work_date.localeCompare(b.work_date))
      })
    }
  }

  async function fetchEmployeeMonthEntries() {
    if (!profile) return

    const { start, end } = getMonthRangeFromDate(employeeWeek)

    const { data, error } = await supabase
      .from("time_entries")
      .select("*")
      .eq("user_id", profile.id)
      .gte("work_date", start)
      .lte("work_date", end)
      .order("work_date", { ascending: true })

    if (!error) setEmployeeMonthEntries(data || [])
  }

  async function fetchAdminEntries() {
    const { start, end } = getPeriodRange(adminWeek, adminPeriodMode)

    const { data, error } = await supabase
      .from("time_entries")
      .select("*")
      .eq("user_id", adminSelectedUserId)
      .gte("work_date", start)
      .lte("work_date", end)
      .order("work_date", { ascending: true })

    if (!error) {
      setAdminEntries((current) => {
        const dirty = adminDirtyDates
        const unsaved = current.filter((entry) => dirty.has(entry.work_date))
        const fresh = data || []
        const freshWithoutDirty = fresh.filter((entry) => !dirty.has(entry.work_date))
        return [...freshWithoutDirty, ...unsaved].sort((a, b) => a.work_date.localeCompare(b.work_date))
      })
    }
  }

  async function fetchAdminMonthEntries() {
    if (!adminSelectedUserId) return

    const { start, end } = getMonthRangeFromDate(adminWeek)

    const { data, error } = await supabase
      .from("time_entries")
      .select("*")
      .eq("user_id", adminSelectedUserId)
      .gte("work_date", start)
      .lte("work_date", end)
      .order("work_date", { ascending: true })

    if (!error) setAdminMonthEntries(data || [])
  }

  function updateEmployeeLocalEntry(date: string, changes: Partial<TimeEntry>) {
    if (!profile) return

    setEmployeeEntries((current) => {
      const existing = current.find((entry) => entry.work_date === date)
      const base = existing || getEmptyEntry(profile.id, date)
      const updated = { ...base, ...changes }

      if (existing) {
        return current.map((entry) => (entry.work_date === date ? updated : entry))
      }

      return [...current, updated].sort((a, b) => a.work_date.localeCompare(b.work_date))
    })

    setEmployeeDirtyDates((current) => new Set(current).add(date))
  }

  function updateAdminLocalEntry(date: string, changes: Partial<TimeEntry>) {
    if (!adminSelectedUserId) return

    setAdminEntries((current) => {
      const existing = current.find((entry) => entry.work_date === date)
      const base = existing || getEmptyEntry(adminSelectedUserId, date)
      const updated = { ...base, ...changes }

      if (existing) {
        return current.map((entry) => (entry.work_date === date ? updated : entry))
      }

      return [...current, updated].sort((a, b) => a.work_date.localeCompare(b.work_date))
    })

    setAdminDirtyDates((current) => new Set(current).add(date))
  }

  async function saveEmployeeEntry(date: string) {
    if (!profile) return

    const entry = employeeEntries.find((e) => e.work_date === date) || getEmptyEntry(profile.id, date)
    setEmployeeSavingDate(date)

    const { data, error } = await supabase
      .from("time_entries")
      .upsert(normalizeEntryForSave(entry), { onConflict: "user_id,work_date" })
      .select()
      .single()

    setEmployeeSavingDate(null)

    if (error) {
      alert("Fehler beim Speichern: " + error.message)
      return
    }

    setEmployeeEntries((current) =>
      current.map((e) => (e.work_date === date ? data : e))
    )
    setEmployeeDirtyDates((current) => {
      const next = new Set(current)
      next.delete(date)
      return next
    })

    await fetchEmployeeMonthEntries()
    await fetchAllEntriesUntilToday()
  }

  async function saveAdminEntry(date: string) {
    const entry = adminEntries.find((e) => e.work_date === date) || getEmptyEntry(adminSelectedUserId, date)
    setAdminSavingDate(date)

    const { data, error } = await supabase
      .from("time_entries")
      .upsert(normalizeEntryForSave(entry), { onConflict: "user_id,work_date" })
      .select()
      .single()

    setAdminSavingDate(null)

    if (error) {
      alert("Fehler beim Speichern: " + error.message)
      return
    }

    setAdminEntries((current) =>
      current.map((e) => (e.work_date === date ? data : e))
    )
    setAdminDirtyDates((current) => {
      const next = new Set(current)
      next.delete(date)
      return next
    })

    await fetchAdminMonthEntries()
    await fetchAllEntriesUntilToday()
  }

  async function saveAllEmployeeEntries() {
    if (!profile) return

    const dates = Array.from(employeeDirtyDates)
    if (dates.length === 0) return

    const payload = dates.map((date) => {
      const entry =
        employeeEntries.find((e) => e.work_date === date) || getEmptyEntry(profile.id, date)
      return normalizeEntryForSave(entry)
    })

    setEmployeeSavingAll(true)

    const { error } = await supabase
      .from("time_entries")
      .upsert(payload, { onConflict: "user_id,work_date" })
      .select()

    setEmployeeSavingAll(false)

    if (error) {
      alert("Fehler beim Speichern: " + error.message)
      return
    }

    setEmployeeDirtyDates(new Set())
    await fetchEmployeeEntries()
    await fetchEmployeeMonthEntries()
    await fetchAllEntriesUntilToday()
  }

  async function saveAllAdminEntries() {
    if (!adminSelectedUserId) return

    const dates = Array.from(adminDirtyDates)
    if (dates.length === 0) return

    const payload = dates.map((date) => {
      const entry =
        adminEntries.find((e) => e.work_date === date) || getEmptyEntry(adminSelectedUserId, date)
      return normalizeEntryForSave(entry)
    })

    setAdminSavingAll(true)

    const { error } = await supabase
      .from("time_entries")
      .upsert(payload, { onConflict: "user_id,work_date" })
      .select()

    setAdminSavingAll(false)

    if (error) {
      alert("Fehler beim Speichern: " + error.message)
      return
    }

    setAdminDirtyDates(new Set())
    await fetchAdminEntries()
    await fetchAdminMonthEntries()
    await fetchAllEntriesUntilToday()
  }

  async function createEmployeeUser() {
    const normalizedEmail = createEmail.trim().toLowerCase()
    const internalLoginRegex = /^[a-z]+(?:-[a-z]+)*\.[a-z]+(?:-[a-z]+)*@zeiterfassung\.local$/

    if (!createFullName || !normalizedEmail || !createPassword) {
      alert("Bitte Name, Login-Adresse und Passwort ausfüllen.")
      return
    }

    if (!internalLoginRegex.test(normalizedEmail)) {
      alert(
        "Login-Adresse muss dem Schema vorname.nachname@zeiterfassung.local entsprechen. Beispiel: max.mustermann@zeiterfassung.local"
      )
      return
    }

    if (createPassword.length < 8) {
      alert("Das Passwort muss mindestens 8 Zeichen haben.")
      return
    }

    setCreateUserLoading(true)

    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session) {
      alert("Keine gültige Session. Bitte neu anmelden.")
      setCreateUserLoading(false)
      return
    }

    const response = await fetch("/api/admin/create-user", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        fullName: createFullName.trim(),
        email: normalizedEmail,
        password: createPassword,
        role: createRole,
      }),
    })

    const responseData = await response.json()
    setCreateUserLoading(false)

    if (!response.ok || !responseData.success) {
      alert(responseData.error || "Mitarbeiter konnte nicht angelegt werden.")
      return
    }

    alert("Mitarbeiter wurde erfolgreich angelegt.")
    setCreateFullName("")
    setCreateEmail("")
    setCreatePassword("")
    setCreateRole("employee")
    await fetchProfiles()
  }

  async function resetEmployeePassword() {
    if (!resetPasswordUserId || !newPassword) {
      alert("Bitte Mitarbeiter und neues Passwort auswählen.")
      return
    }

    if (newPassword.length < 8) {
      alert("Das Passwort muss mindestens 8 Zeichen haben.")
      return
    }

    setResetPasswordLoading(true)

    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session) {
      alert("Keine gültige Session. Bitte neu anmelden.")
      setResetPasswordLoading(false)
      return
    }

    const response = await fetch("/api/admin/reset-password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ userId: resetPasswordUserId, newPassword }),
    })

    const responseData = await response.json()
    setResetPasswordLoading(false)

    if (!response.ok || !responseData.success) {
      alert(responseData.error || "Passwort konnte nicht zurückgesetzt werden.")
      return
    }

    alert("Passwort wurde erfolgreich zurückgesetzt.")
    setNewPassword("")
  }

  async function toggleEmployeeActive(userId: string, nextActiveState: boolean) {
    setActiveLoadingId(userId)

    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session) {
      alert("Keine gültige Session. Bitte neu anmelden.")
      setActiveLoadingId(null)
      return
    }

    const response = await fetch("/api/admin/set-active", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ userId, isActive: nextActiveState }),
    })

    const responseData = await response.json()
    setActiveLoadingId(null)

    if (!response.ok || !responseData.success) {
      alert(responseData.error || "Status konnte nicht geändert werden.")
      return
    }

    await fetchProfiles()
  }

  async function exportExcel(userIds: string[], from: string, to: string, filename: string) {
    const { data, error } = await supabase
      .from("time_entries")
      .select("*")
      .in("user_id", userIds)
      .gte("work_date", from)
      .lte("work_date", to)
      .order("work_date", { ascending: true })

    if (error) {
      alert("Export fehlgeschlagen: " + error.message)
      return
    }

    const header = [
      "Mitarbeiter",
      "Login",
      "Datum",
      "Typ",
      "Arbeitsbeginn",
      "Arbeitsende",
      "Pause Minuten",
      "Gesamtstunden",
      "Notiz",
    ]

    const rows = (data || []).map((entry: TimeEntry) => {
      const employee = profiles.find((p) => p.id === entry.user_id)
      return [
        employee?.full_name || "",
        employee?.email || "",
        entry.work_date,
        entryTypeLabels[entry.entry_type],
        entry.start_time || "",
        entry.end_time || "",
        String(entry.break_minutes || 0),
        (calculateMinutes(entry) / 60).toFixed(2).replace(".", ","),
        entry.note || "",
      ]
    })

    excelDownload(filename, [header, ...rows])
  }

  // Arbeitsstunden der aktuellen Kalenderwoche (Mo–So, nach deutscher Zeit).
  const employeeWeekSummary = useMemo(() => {
    if (!profile) return 0
    const monday = getMonday(berlinNow())
    const weekStart = formatDate(monday)
    const weekEnd = formatDate(addDays(monday, 6))

    return allEntriesUntilToday
      .filter(
        (entry) =>
          entry.user_id === profile.id &&
          entry.work_date >= weekStart &&
          entry.work_date <= weekEnd
      )
      .reduce((sum, entry) => sum + calculateMinutes(entry), 0)
  }, [profile, allEntriesUntilToday])

  const adminTotalCurrentMonth = useMemo(() => {
    const { start } = getMonthRangeFromDate(berlinNow())
    const today = todayDateString()

    return allEntriesUntilToday
      .filter((entry) => entry.work_date >= start && entry.work_date <= today)
      .reduce((sum, entry) => sum + calculateMinutes(entry), 0)
  }, [allEntriesUntilToday])

  // Zusammenfassung für den aktuell angezeigten Monat des ausgewählten Mitarbeiters.
  const adminMonthLabel = adminWeek.toLocaleDateString("de-DE", {
    month: "long",
    year: "numeric",
  })

  const adminMonthSummary = useMemo(() => {
    return {
      workMinutes: adminMonthEntries.reduce((sum, entry) => sum + calculateMinutes(entry), 0),
      vacationDays: adminMonthEntries.filter((entry) => entry.entry_type === "vacation").length,
      sickDays: adminMonthEntries.filter((entry) => entry.entry_type === "sick").length,
      dayOffDays: adminMonthEntries.filter((entry) => entry.entry_type === "day_off").length,
    }
  }, [adminMonthEntries])

  const adminTopThree = useMemo(() => {
    return profiles
      .map((p) => {
        const minutes = allEntriesUntilToday
          .filter((entry) => entry.user_id === p.id)
          .reduce((sum, entry) => sum + calculateMinutes(entry), 0)
        return { profile: p, minutes }
      })
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 3)
  }, [profiles, allEntriesUntilToday])

  // Monatsname des aktuell angezeigten Monats (folgt der Navigation in der Tabelle).
  const employeeMonthLabel = employeeWeek.toLocaleDateString("de-DE", {
    month: "long",
    year: "numeric",
  })

  const employeeMonthSummary = useMemo(() => {
    return {
      workMinutes: employeeMonthEntries.reduce((sum, entry) => sum + calculateMinutes(entry), 0),
      vacationDays: employeeMonthEntries.filter((entry) => entry.entry_type === "vacation").length,
      sickDays: employeeMonthEntries.filter((entry) => entry.entry_type === "sick").length,
      dayOffDays: employeeMonthEntries.filter((entry) => entry.entry_type === "day_off").length,
    }
  }, [employeeMonthEntries])

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p>Lade...</p>
      </main>
    )
  }

  if (!profile) {
    return <LoginScreen onLogin={init} />
  }

  return (
    <main className={darkMode ? "time-app time-app-dark min-h-screen bg-neutral-950 p-4 text-neutral-100" : "time-app time-app-light min-h-screen bg-neutral-200 p-4 text-neutral-950"}>
      <style jsx global>{`
        .time-app-light .bg-white {
          background-color: #f8fafc !important;
          color: #0f172a !important;
        }

        .time-app-light .bg-neutral-50 {
          background-color: #e5e7eb !important;
        }

        .time-app-light .border,
        .time-app-light .border-b {
          border-color: #cbd5e1 !important;
        }

        .time-app-light input,
        .time-app-light select {
          background-color: #ffffff !important;
          color: #0f172a !important;
          border-color: #94a3b8 !important;
        }

        .time-app-light input:disabled,
        .time-app-light select:disabled {
          background-color: #e5e7eb !important;
          color: #64748b !important;
        }

        .time-app-dark {
          background-color: #020617 !important;
          color: #e5e7eb !important;
        }

        .time-app-dark .bg-white,
        .time-app-dark .bg-neutral-50,
        .time-app-dark .bg-neutral-100,
        .time-app-dark .bg-neutral-200 {
          background-color: #0f172a !important;
          color: #e5e7eb !important;
        }

        .time-app-dark .text-neutral-400,
        .time-app-dark .text-neutral-500,
        .time-app-dark .text-neutral-600,
        .time-app-dark .text-neutral-700 {
          color: #cbd5e1 !important;
        }

        .time-app-dark .border,
        .time-app-dark .border-b {
          border-color: #334155 !important;
        }

        .time-app-dark input,
        .time-app-dark select {
          background-color: #020617 !important;
          color: #f8fafc !important;
          border-color: #475569 !important;
        }

        .time-app-dark input::placeholder {
          color: #94a3b8 !important;
        }

        .time-app-dark input:disabled,
        .time-app-dark select:disabled {
          background-color: #1e293b !important;
          color: #94a3b8 !important;
        }

        .time-app-dark .shadow {
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35) !important;
        }

        .time-app-dark .bg-black {
          background-color: #2563eb !important;
        }

        .time-app-dark .hover\:bg-neutral-100:hover {
          background-color: #1e293b !important;
        }
      `}</style>

      <div className="flex flex-col gap-4 lg:flex-row">
        <Sidebar
          profile={profile}
          activeView={profile.role === "admin" ? adminView : employeeView}
          setActiveView={profile.role === "admin" ? setAdminView : setEmployeeView}
          onLogout={handleLogout}
          darkMode={darkMode}
          toggleDarkMode={toggleDarkMode}
        />

        <section className="flex-1 space-y-6">
          {profile.role === "employee" && employeeView === "dashboard" && (
            <>
              <div className="rounded-2xl bg-white p-6 shadow">
                <h2 className="text-2xl font-bold">Mitarbeiter Dashboard</h2>
                <p className="mt-1 text-sm text-neutral-600">
                  Übersicht deiner bisher erfassten Arbeitszeit.
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-4">
                <StatCard title="Wochenstunden" value={formatHours(employeeWeekSummary)} subtitle="Aktuelle Woche" />
                <StatCard title="Monatsstunden" value={formatHours(employeeMonthSummary.workMinutes)} subtitle={employeeMonthLabel} />
                <StatCard title="Urlaubstage im Monat" value={employeeMonthSummary.vacationDays} />
                <StatCard title="Kranktage im Monat" value={employeeMonthSummary.sickDays} />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <button
                  onClick={() => setEmployeeView("time")}
                  className="rounded-2xl bg-black p-6 text-left text-white shadow"
                >
                  <p className="text-lg font-bold">Zeiten erfassen</p>
                  <p className="mt-1 text-sm text-white/70">Direkt zur Wochenübersicht springen.</p>
                </button>
                <button
                  onClick={() => setEmployeeView("export")}
                  className="rounded-2xl bg-white p-6 text-left shadow"
                >
                  <p className="text-lg font-bold">Eigene Zeiten exportieren</p>
                  <p className="mt-1 text-sm text-neutral-600">Zeitraum auswählen und Excel herunterladen.</p>
                </button>
              </div>
            </>
          )}

          {profile.role === "employee" && employeeView === "time" && (
            <TimeEntryTable
              userId={profile.id}
              anchorDate={employeeWeek}
              setAnchorDate={setEmployeeWeek}
              periodMode={employeePeriodMode}
              setPeriodMode={setEmployeePeriodMode}
              entries={employeeEntries}
              dirtyDates={employeeDirtyDates}
              savingDate={employeeSavingDate}
              onChangeEntry={updateEmployeeLocalEntry}
              onSaveEntry={saveEmployeeEntry}
              onSaveAll={saveAllEmployeeEntries}
              isSavingAll={employeeSavingAll}
              title="Zeiten erfassen"
            />
          )}

          {profile.role === "employee" && employeeView === "overview" && (
            <>
              <div className="grid gap-4 md:grid-cols-4">
                <StatCard title="Wochenstunden" value={formatHours(employeeWeekSummary)} subtitle="Aktuelle Woche" />
                <StatCard title="Monatsstunden" value={formatHours(employeeMonthSummary.workMinutes)} subtitle={employeeMonthLabel} />
                <StatCard title="Urlaubstage" value={employeeMonthSummary.vacationDays} />
                <StatCard title="Kranktage" value={employeeMonthSummary.sickDays} />
              </div>

              <TimeEntryTable
                userId={profile.id}
                anchorDate={employeeWeek}
                setAnchorDate={setEmployeeWeek}
                periodMode={employeePeriodMode}
                setPeriodMode={setEmployeePeriodMode}
                entries={employeeEntries}
                dirtyDates={employeeDirtyDates}
                savingDate={employeeSavingDate}
                onChangeEntry={updateEmployeeLocalEntry}
                onSaveEntry={saveEmployeeEntry}
                onSaveAll={saveAllEmployeeEntries}
                isSavingAll={employeeSavingAll}
                title="Meine Übersicht"
              />
            </>
          )}

          {profile.role === "employee" && employeeView === "export" && (
            <div className="rounded-2xl bg-white p-6 shadow">
              <h2 className="text-xl font-bold">Eigene Zeiten exportieren</h2>
              <div className="mt-4 grid gap-4 md:grid-cols-3">
                <div>
                  <label className="text-sm font-medium">Von</label>
                  <input
                    type="date"
                    value={exportFrom}
                    onChange={(e) => setExportFrom(e.target.value)}
                    className="mt-1 w-full rounded-lg border px-3 py-2"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Bis</label>
                  <input
                    type="date"
                    value={exportTo}
                    onChange={(e) => setExportTo(e.target.value)}
                    className="mt-1 w-full rounded-lg border px-3 py-2"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    onClick={() => exportExcel([profile.id], exportFrom, exportTo, `zeiterfassung-${profile.full_name}.xlsx`)}
                    className="w-full rounded-lg bg-black px-4 py-2 font-medium text-white"
                  >
                    Excel exportieren
                  </button>
                </div>
              </div>
            </div>
          )}

          {profile.role === "admin" && adminView === "dashboard" && (
            <>
              <div className="rounded-2xl bg-white p-6 shadow">
                <h2 className="text-2xl font-bold">Admin Dashboard</h2>
                <p className="mt-1 text-sm text-neutral-600">
                  Übersicht aller bisher erfassten Arbeitszeiten bis heute.
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-4">
                <StatCard title="Gesamtstunden alle Mitarbeiter" value={formatHours(adminTotalCurrentMonth)} subtitle="Laufender Monat bis heute" />
                <StatCard title="Aktive Mitarbeiter" value={profiles.filter((p) => p.is_active).length} />
                <StatCard title="Inaktive Mitarbeiter" value={profiles.filter((p) => !p.is_active).length} />
                <StatCard title="Erfasste Einträge" value={allEntriesUntilToday.length} />
              </div>

              <div className="grid gap-4 xl:grid-cols-2">
                <div className="rounded-2xl bg-white p-6 shadow">
                  <h3 className="text-lg font-bold">Top 3 Mitarbeiter</h3>
                  <div className="mt-4 space-y-3">
                    {adminTopThree.map((row, index) => (
                      <div key={row.profile.id} className="flex items-center justify-between rounded-xl border p-4">
                        <div>
                          <p className="font-bold">Platz {index + 1}: {row.profile.full_name}</p>
                          <p className="text-sm text-neutral-500">{row.profile.email}</p>
                        </div>
                        <p className="font-bold">{formatHours(row.minutes)}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-2xl bg-white p-6 shadow">
                  <h3 className="text-lg font-bold">Schnell-Export</h3>
                  <p className="mt-1 text-sm text-neutral-600">
                    Zeitraum auswählen und Mitarbeiter exportieren.
                  </p>

                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <div>
                      <label className="text-sm font-medium">Von</label>
                      <input
                        type="date"
                        value={exportFrom}
                        onChange={(e) => setExportFrom(e.target.value)}
                        className="mt-1 w-full rounded-lg border px-3 py-2"
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium">Bis</label>
                      <input
                        type="date"
                        value={exportTo}
                        onChange={(e) => setExportTo(e.target.value)}
                        className="mt-1 w-full rounded-lg border px-3 py-2"
                      />
                    </div>
                  </div>

                  <button
                    onClick={() => setExportSelectedUserIds(profiles.map((p) => p.id))}
                    className="mt-4 rounded-lg border px-4 py-2"
                  >
                    Alle Mitarbeiter auswählen
                  </button>

                  <button
                    onClick={() => exportExcel(exportSelectedUserIds, exportFrom, exportTo, `zeiterfassung-export.xlsx`)}
                    className="mt-4 w-full rounded-lg bg-black px-4 py-2 font-medium text-white"
                  >
                    Excel-Export starten
                  </button>
                </div>
              </div>
            </>
          )}

          {profile.role === "admin" && adminView === "edit-times" && (
            <div className="space-y-4">
              <div className="rounded-2xl bg-white p-6 shadow">
                <h2 className="text-xl font-bold">Zeiten bearbeiten</h2>
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <div>
                    <label className="text-sm font-medium">Mitarbeiter</label>
                    <select
                      value={adminSelectedUserId}
                      onChange={(e) => setAdminSelectedUserId(e.target.value)}
                      className="mt-1 w-full rounded-lg border px-3 py-2"
                    >
                      {profiles.map((p) => (
                        <option key={p.id} value={p.id}>{p.full_name}</option>
                      ))}
                    </select>
                  </div>

                  <div className="rounded-xl border bg-neutral-50 p-4">
                    <p className="text-sm text-neutral-500">
                      Arbeitsstunden {adminMonthLabel}
                    </p>
                    <p className="mt-2 text-3xl font-bold">
                      {formatHours(adminMonthSummary.workMinutes)}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-600">
                      <span>Urlaub: {adminMonthSummary.vacationDays} Tage</span>
                      <span>Krank: {adminMonthSummary.sickDays} Tage</span>
                      <span>Frei: {adminMonthSummary.dayOffDays} Tage</span>
                    </div>
                    {selectedAdminProfile && (
                      <p className="mt-2 text-xs text-neutral-500">
                        {selectedAdminProfile.full_name}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <TimeEntryTable
                userId={adminSelectedUserId}
                anchorDate={adminWeek}
                setAnchorDate={setAdminWeek}
                periodMode={adminPeriodMode}
                setPeriodMode={setAdminPeriodMode}
                entries={adminEntries}
                dirtyDates={adminDirtyDates}
                savingDate={adminSavingDate}
                onChangeEntry={updateAdminLocalEntry}
                onSaveEntry={saveAdminEntry}
                onSaveAll={saveAllAdminEntries}
                isSavingAll={adminSavingAll}
                title={`Zeiten bearbeiten${selectedAdminProfile ? `: ${selectedAdminProfile.full_name}` : ""}`}
              />
            </div>
          )}

          {profile.role === "admin" && adminView === "create-user" && (
            <div className="rounded-2xl bg-white p-6 shadow">
              <h2 className="text-xl font-bold">Mitarbeiter anlegen</h2>
              <p className="mt-1 text-sm text-neutral-600">
                Login-Adresse muss dem Schema vorname.nachname@zeiterfassung.local entsprechen.
              </p>

              <div className="mt-4 grid gap-4 xl:grid-cols-5">
                <div>
                  <label className="text-sm font-medium">Name</label>
                  <input value={createFullName} onChange={(e) => setCreateFullName(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" placeholder="Vorname Nachname" />
                </div>
                <div>
                  <label className="text-sm font-medium">Login-Adresse</label>
                  <input value={createEmail} onChange={(e) => setCreateEmail(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" placeholder="vorname.nachname@zeiterfassung.local" />
                </div>
                <div>
                  <label className="text-sm font-medium">Startpasswort</label>
                  <input value={createPassword} onChange={(e) => setCreatePassword(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" placeholder="Passwort" />
                </div>
                <div>
                  <label className="text-sm font-medium">Rolle</label>
                  <select value={createRole} onChange={(e) => setCreateRole(e.target.value as "employee" | "admin")} className="mt-1 w-full rounded-lg border px-3 py-2">
                    <option value="employee">Mitarbeiter</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <div className="flex items-end">
                  <button onClick={createEmployeeUser} disabled={createUserLoading} className="w-full rounded-lg bg-black px-4 py-2 font-medium text-white disabled:opacity-50">
                    {createUserLoading ? "Wird angelegt..." : "Anlegen"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {profile.role === "admin" && adminView === "reset-password" && (
            <div className="rounded-2xl bg-white p-6 shadow">
              <h2 className="text-xl font-bold">Passwort zurücksetzen</h2>
              <div className="mt-4 grid gap-4 md:grid-cols-3">
                <div>
                  <label className="text-sm font-medium">Mitarbeiter</label>
                  <select value={resetPasswordUserId} onChange={(e) => setResetPasswordUserId(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2">
                    <option value="">Bitte auswählen</option>
                    {profiles.map((p) => <option key={p.id} value={p.id}>{p.full_name} ({p.email})</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-sm font-medium">Neues Passwort</label>
                  <input value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" placeholder="Neues Passwort" />
                </div>
                <div className="flex items-end">
                  <button onClick={resetEmployeePassword} disabled={resetPasswordLoading} className="w-full rounded-lg bg-black px-4 py-2 font-medium text-white disabled:opacity-50">
                    {resetPasswordLoading ? "Wird geändert..." : "Passwort ändern"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {profile.role === "admin" && adminView === "manage-users" && (
            <div className="rounded-2xl bg-white p-6 shadow">
              <h2 className="text-xl font-bold">Mitarbeiter verwalten</h2>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[850px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b bg-neutral-50 text-left">
                      <th className="p-3">Mitarbeiter</th>
                      <th className="p-3">Login</th>
                      <th className="p-3">Rolle</th>
                      <th className="p-3">Status</th>
                      <th className="p-3">Aktion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profiles.map((p) => (
                      <tr key={p.id} className="border-b">
                        <td className="p-3 font-medium">{p.full_name}</td>
                        <td className="p-3">{p.email}</td>
                        <td className="p-3">{p.role}</td>
                        <td className="p-3">{p.is_active ? "Aktiv" : "Inaktiv"}</td>
                        <td className="p-3">
                          <button
                            onClick={() => toggleEmployeeActive(p.id, !p.is_active)}
                            disabled={activeLoadingId === p.id}
                            className={p.is_active ? "rounded-lg border border-red-300 px-3 py-2 text-red-700" : "rounded-lg border border-green-300 px-3 py-2 text-green-700"}
                          >
                            {activeLoadingId === p.id ? "Ändert..." : p.is_active ? "Deaktivieren" : "Aktivieren"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {profile.role === "admin" && adminView === "export" && (
            <div className="rounded-2xl bg-white p-6 shadow">
              <h2 className="text-xl font-bold">Export</h2>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div>
                  <label className="text-sm font-medium">Von</label>
                  <input type="date" value={exportFrom} onChange={(e) => setExportFrom(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" />
                </div>
                <div>
                  <label className="text-sm font-medium">Bis</label>
                  <input type="date" value={exportTo} onChange={(e) => setExportTo(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" />
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button onClick={() => setExportSelectedUserIds(profiles.map((p) => p.id))} className="rounded-lg border px-4 py-2">Alle Mitarbeiter auswählen</button>
                <button onClick={() => setExportSelectedUserIds([])} className="rounded-lg border px-4 py-2">Auswahl leeren</button>
              </div>

              <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {profiles.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 rounded-lg border p-3">
                    <input
                      type="checkbox"
                      checked={exportSelectedUserIds.includes(p.id)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setExportSelectedUserIds((current) => [...current, p.id])
                        } else {
                          setExportSelectedUserIds((current) => current.filter((id) => id !== p.id))
                        }
                      }}
                    />
                    <span>{p.full_name}</span>
                  </label>
                ))}
              </div>

              <button
                onClick={() => exportExcel(exportSelectedUserIds, exportFrom, exportTo, "zeiterfassung-export.xlsx")}
                className="mt-6 rounded-lg bg-black px-4 py-2 font-medium text-white"
              >
                Excel exportieren
              </button>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
