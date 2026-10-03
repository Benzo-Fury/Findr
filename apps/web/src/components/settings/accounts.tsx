import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { CaretDownIcon, CheckIcon, DiceFiveIcon, EyeIcon, EyeSlashIcon, KeyIcon, SignOutIcon, TrashIcon, UserPlusIcon } from "@phosphor-icons/react"
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@findr/types/account"
import { authClient, useSession } from "@/lib/auth"
import { formatRelativeTime } from "@/lib/format"
import { FADE, SPRING_PANEL, SPRING_SNAP } from "@/lib/motion"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Field, TextInput } from "@/components/ui/field"
import { Segmented } from "@/components/ui/segmented"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/components/ui/toast"

/** The fields of a BetterAuth user this list shows. */
interface AccountRow {
  id: string
  name: string
  email: string
  role?: string | null
  createdAt: Date | string
}

type Role = "user" | "admin"

const ROLE_OPTIONS = [
  { value: "user", label: "User" },
  { value: "admin", label: "Admin" },
] as const

const EMPTY_FORM = { name: "", email: "", password: "", role: "user" as Role }

/** Characters a generated password draws from, without look-alikes such as `l`, `1`, `O` and `0`. */
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

/** A random password of four dash-separated groups, easy to read aloud and well past the minimum length. */
function generatePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const characters = Array.from(bytes, (byte) => PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length])
  return [0, 4, 8, 12].map((start) => characters.slice(start, start + 4).join("")).join("-")
}

/** The role BetterAuth reports, narrowed to the two Findr uses. */
function roleOf(user: AccountRow): Role {
  return user.role === "admin" ? "admin" : "user"
}

/**
 * Account management through BetterAuth's admin plugin, the only way new
 * accounts exist. Each account opens into an editor for its profile, role
 * and password. Changes here apply immediately rather than through the save
 * dock, since they are actions, not settings.
 */
export function Accounts() {
  const { data: session, refetch } = useSession()
  const toast = useToast()
  const [users, setUsers] = React.useState<AccountRow[] | null>(null)
  const [open, setOpen] = React.useState<string | null>(null)
  const [form, setForm] = React.useState(EMPTY_FORM)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    const { data } = await authClient.admin.listUsers({ query: { limit: 100, sortBy: "createdAt", sortDirection: "asc" } })
    setUsers(data?.users ?? [])
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  // Edits to your own account also refresh the session the shell shows
  const changed = React.useCallback(
    async (user: AccountRow) => {
      await load()
      if (user.id === session?.user.id) await refetch()
    },
    [load, refetch, session?.user.id],
  )

  async function create(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const { error: failure } = await authClient.admin.createUser(form)
    if (failure) setError(failure.message ?? "Could not create the account")
    else {
      toast({ title: "Account created", description: form.email })
      setForm(EMPTY_FORM)
      await load()
    }
    setBusy(false)
  }

  return (
    <div className="py-4">
      {users === null ? (
        <div className="space-y-2">
          <Skeleton className="h-14 rounded-[0.875rem]" />
          <Skeleton className="h-14 rounded-[0.875rem]" />
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          <AnimatePresence initial={false}>
            {users.map((user) => (
              <motion.li
                key={user.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: 24 }}
                transition={FADE}
              >
                <Account
                  user={user}
                  self={user.id === session?.user.id}
                  open={open === user.id}
                  onToggle={() => setOpen(open === user.id ? null : user.id)}
                  onChanged={() => changed(user)}
                  onRemoved={() => {
                    setOpen(null)
                    load()
                  }}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      <form onSubmit={create} className="mt-6 rounded-panel bg-paper p-4 shadow-ring md:p-5">
        <p className="heading mb-4 text-lg text-ink">New account</p>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name">{({ id }) => <TextInput id={id} value={form.name} autoComplete="off" onChange={(event) => setForm({ ...form, name: event.target.value })} required />}</Field>
          <Field label="Email">{({ id }) => <TextInput id={id} type="email" value={form.email} autoComplete="off" onChange={(event) => setForm({ ...form, email: event.target.value })} required />}</Field>
          <Field label="Password" help={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
            {({ id, describedBy }) => (
              <PasswordInput id={id} describedBy={describedBy} value={form.password} onChange={(password) => setForm({ ...form, password })} />
            )}
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-ink">Role</span>
            <Segmented label="Role" value={form.role} onChange={(role) => setForm({ ...form, role })} options={ROLE_OPTIONS} className="self-start" />
          </div>
        </div>
        {error && <p role="alert" className="mt-4 text-[0.875rem] font-medium text-bad">{error}</p>}
        <Button type="submit" variant="ink" icon={UserPlusIcon} loading={busy} className="mt-5">
          Create account
        </Button>
      </form>
    </div>
  )
}

// ---------- One account ---------- //

interface AccountProps {
  user: AccountRow
  /** Whether this is the signed-in admin, who cannot change their own role or remove themselves. */
  self: boolean
  open: boolean
  onToggle: () => void
  /** Called after any edit, so the list reloads. */
  onChanged: () => void
  onRemoved: () => void
}

/** A row that opens into the account's editor. */
function Account({ user, self, open, onToggle, onChanged, onRemoved }: AccountProps) {
  const editorId = React.useId()

  return (
    <div className={cn("rounded-[0.875rem] transition-[background-color,box-shadow] duration-300", open && "bg-paper shadow-ring")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={editorId}
        onClick={onToggle}
        className="flex w-full items-center gap-3 rounded-[0.875rem] px-2 py-2 text-left outline-none transition-colors hover:bg-sunken/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-full font-display text-sm font-semibold transition-colors duration-300",
            open ? "bg-ink text-surface" : "bg-sunken text-ink-2",
          )}
        >
          {(user.name || user.email).slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.9375rem] font-semibold text-ink">
            {user.name || user.email}
            {self && <span className="ml-2 text-micro font-medium text-ink-3">You</span>}
          </span>
          <span className="block truncate text-[0.8125rem] text-ink-2">{user.email}</span>
        </span>
        {roleOf(user) === "admin" && <span className="rounded-full bg-signal-soft px-2.5 py-1 text-micro font-semibold text-signal-ink">Admin</span>}
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={SPRING_SNAP} className="flex size-8 items-center justify-center text-ink-3">
          <CaretDownIcon aria-hidden weight="bold" className="size-4" />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={editorId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={SPRING_PANEL}
            className="overflow-hidden"
          >
            <Editor user={user} self={self} onChanged={onChanged} onRemoved={onRemoved} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ---------- Editor ---------- //

/** Which of the editor's actions is in flight. */
type Pending = "profile" | "role" | "password" | "sessions" | "remove" | null

/** The result shape every BetterAuth client call shares. */
type AuthResult = { error: { message?: string } | null }

interface EditorProps {
  user: AccountRow
  self: boolean
  onChanged: () => void
  onRemoved: () => void
}

/** Profile, role and password for one account, plus signing it out everywhere and removing it. */
function Editor({ user, self, onChanged, onRemoved }: EditorProps) {
  const toast = useToast()
  const [pending, setPending] = React.useState<Pending>(null)
  const [profile, setProfile] = React.useState({ name: user.name, email: user.email })
  const [role, setRole] = React.useState<Role>(roleOf(user))
  const [password, setPassword] = React.useState("")
  const [confirming, setConfirming] = React.useState(false)

  const dirty = profile.name.trim() !== user.name || profile.email.trim().toLowerCase() !== user.email

  // Runs one action, reporting failure as a toast; answers whether it succeeded
  async function run(action: Exclude<Pending, null>, call: () => Promise<AuthResult>, failure: string): Promise<boolean> {
    setPending(action)
    const { error } = await call()
    setPending(null)
    if (error) toast({ title: failure, description: error.message, tone: "bad" })
    return !error
  }

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault()
    const data = { name: profile.name.trim(), email: profile.email.trim().toLowerCase() }
    if (!(await run("profile", () => authClient.admin.updateUser({ userId: user.id, data }), "Could not save the profile"))) return
    toast({ title: "Profile saved", description: data.email })
    onChanged()
  }

  async function changeRole(next: Role) {
    const previous = role
    setRole(next)
    if (!(await run("role", () => authClient.admin.setRole({ userId: user.id, role: next }), "Could not change the role"))) {
      setRole(previous)
      return
    }
    toast({ title: next === "admin" ? "Now an admin" : "Now a user", description: user.email })
    onChanged()
  }

  async function setNewPassword(event: React.FormEvent) {
    event.preventDefault()
    if (!(await run("password", () => authClient.admin.setUserPassword({ userId: user.id, newPassword: password }), "Could not set the password"))) return

    // Anyone else is signed out, so the old password stops working everywhere
    if (!self) await authClient.admin.revokeUserSessions({ userId: user.id })
    toast({ title: "Password set", description: self ? undefined : `${user.email} was signed out everywhere` })
    setPassword("")
  }

  async function signOutEverywhere() {
    if (!(await run("sessions", () => authClient.admin.revokeUserSessions({ userId: user.id }), "Could not sign them out"))) return
    toast({ title: "Signed out everywhere", description: user.email })
  }

  async function remove() {
    setConfirming(false)
    if (!(await run("remove", () => authClient.admin.removeUser({ userId: user.id }), "Could not remove the account"))) return
    toast({ title: "Account removed", description: user.email })
    onRemoved()
  }

  return (
    <div className="px-2 pb-3">
      <div className="grid gap-x-8 gap-y-6 rounded-[0.75rem] bg-surface p-4 shadow-ring md:grid-cols-2 md:p-5">
        <Group title="Profile">
          <form onSubmit={saveProfile} className="flex flex-col gap-4">
            <Field label="Name">
              {({ id }) => <TextInput id={id} value={profile.name} autoComplete="off" onChange={(event) => setProfile({ ...profile, name: event.target.value })} required />}
            </Field>
            <Field label="Email">
              {({ id }) => <TextInput id={id} type="email" value={profile.email} autoComplete="off" onChange={(event) => setProfile({ ...profile, email: event.target.value })} required />}
            </Field>
            <Button type="submit" variant="ink" size="sm" icon={CheckIcon} disabled={!dirty} loading={pending === "profile"} className="self-start">
              Save profile
            </Button>
          </form>
        </Group>

        <div className="flex flex-col gap-6">
          <Group title="Role" help={self ? "You can’t change your own role. Another admin can." : "Admins can open Settings and manage accounts."}>
            {self ? (
              <span className="self-start rounded-full bg-signal-soft px-3 py-1.5 text-[0.8125rem] font-semibold text-signal-ink">Admin</span>
            ) : (
              <Segmented label="Role" value={role} onChange={changeRole} options={ROLE_OPTIONS} size="sm" className={cn("self-start", pending === "role" && "pointer-events-none opacity-60")} />
            )}
          </Group>

          <Group title="Password" help={self ? "Replaces the password you sign in with." : "Replaces their password and signs them out of every device."}>
            <form onSubmit={setNewPassword} className="flex flex-col gap-3">
              <PasswordInput label="New password" value={password} onChange={setPassword} />
              <Button type="submit" variant="outline" size="sm" icon={KeyIcon} disabled={password.length < MIN_PASSWORD_LENGTH} loading={pending === "password"} className="self-start">
                Set password
              </Button>
            </form>
          </Group>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4 md:col-span-2">
          <span className="mr-auto font-mono text-micro tabular text-ink-3">Joined {formatRelativeTime(new Date(user.createdAt).getTime())}</span>
          {!self && (
            <>
              <Button variant="ghost" size="sm" icon={SignOutIcon} loading={pending === "sessions"} onClick={signOutEverywhere}>
                Sign out everywhere
              </Button>
              <AnimatePresence mode="popLayout" initial={false}>
                {confirming ? (
                  <motion.span key="confirm" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} transition={SPRING_SNAP} className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Keep</Button>
                    <Button variant="danger" size="sm" icon={TrashIcon} onClick={remove}>Remove for good</Button>
                  </motion.span>
                ) : (
                  <motion.span key="remove" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={SPRING_SNAP}>
                    <Button variant="danger" size="sm" icon={TrashIcon} loading={pending === "remove"} onClick={() => setConfirming(true)}>
                      Remove
                    </Button>
                  </motion.span>
                )}
              </AnimatePresence>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

interface GroupProps {
  title: string
  help?: string
  children: React.ReactNode
}

/** A titled block of the editor: a small caps label, a line of help, then its controls. */
function Group({ title, help, children }: GroupProps) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="font-mono text-micro font-medium uppercase tracking-[0.08em] text-ink-3">{title}</h3>
        {help && <p className="mt-1 text-[0.8125rem] leading-relaxed text-ink-2">{help}</p>}
      </div>
      {children}
    </section>
  )
}

// ---------- Password input ---------- //

interface PasswordInputProps {
  value: string
  onChange: (value: string) => void
  /** Ties the input to an outer `Field`'s label; without it the input labels itself. */
  id?: string
  describedBy?: string
  label?: string
}

/**
 * A new-password input with a reveal toggle and a dice that fills in a
 * strong random password, revealed so it can be copied and passed on.
 */
function PasswordInput({ value, onChange, id, describedBy, label }: PasswordInputProps) {
  const [revealed, setRevealed] = React.useState(false)

  return (
    <div className="relative">
      <TextInput
        id={id}
        aria-label={id ? undefined : label}
        aria-describedby={describedBy}
        type={revealed ? "text" : "password"}
        value={value}
        minLength={MIN_PASSWORD_LENGTH}
        maxLength={MAX_PASSWORD_LENGTH}
        autoComplete="new-password"
        spellCheck={false}
        placeholder={label}
        onChange={(event) => onChange(event.target.value)}
        className={cn("pr-[5.25rem]", revealed && value && "font-mono tracking-wide")}
        required
      />
      <span className="absolute inset-y-0 right-1.5 flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={DiceFiveIcon}
          aria-label="Generate a password"
          onClick={() => {
            onChange(generatePassword())
            setRevealed(true)
          }}
        />
        <Button variant="ghost" size="sm" iconOnly icon={revealed ? EyeSlashIcon : EyeIcon} aria-label={revealed ? "Hide password" : "Show password"} onClick={() => setRevealed(!revealed)} />
      </span>
    </div>
  )
}
