import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { TrashIcon, UserPlusIcon } from "@phosphor-icons/react"
import { MIN_PASSWORD_LENGTH } from "@findr/types/account"
import { authClient, useSession } from "@/lib/auth"
import { FADE } from "@/lib/motion"
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
}

type Role = "user" | "admin"

const EMPTY_FORM = { name: "", email: "", password: "", role: "user" as Role }

/**
 * Account management through BetterAuth's admin plugin, the only way new
 * accounts exist. Changes here apply immediately rather than through the
 * save dock, since they are actions, not settings.
 */
export function Accounts() {
  const { data: session } = useSession()
  const toast = useToast()
  const [users, setUsers] = React.useState<AccountRow[] | null>(null)
  const [form, setForm] = React.useState(EMPTY_FORM)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [confirming, setConfirming] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    const { data } = await authClient.admin.listUsers({ query: { limit: 100 } })
    setUsers(data?.users ?? [])
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

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

  async function remove(user: AccountRow) {
    const { error: failure } = await authClient.admin.removeUser({ userId: user.id })
    setConfirming(null)
    if (failure) toast({ title: "Could not remove the account", description: failure.message, tone: "bad" })
    else toast({ title: "Account removed", description: user.email })
    await load()
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
                className="flex items-center gap-3 rounded-[0.875rem] px-2 py-2"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-sunken font-display text-sm font-semibold text-ink-2">
                  {(user.name || user.email).slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.9375rem] font-semibold text-ink">
                    {user.name || user.email}
                    {user.id === session?.user.id && <span className="ml-2 text-micro font-medium text-ink-3">You</span>}
                  </span>
                  <span className="block truncate text-[0.8125rem] text-ink-2">{user.email}</span>
                </span>
                {user.role === "admin" && <span className="rounded-full bg-signal-soft px-2.5 py-1 text-micro font-semibold text-signal-ink">Admin</span>}
                {user.id !== session?.user.id &&
                  (confirming === user.id ? (
                    <span className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>Keep</Button>
                      <Button variant="danger" size="sm" onClick={() => remove(user)}>Remove</Button>
                    </span>
                  ) : (
                    <Button variant="ghost" size="sm" iconOnly icon={TrashIcon} aria-label={`Remove ${user.email}`} onClick={() => setConfirming(user.id)} />
                  ))}
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
              <TextInput id={id} type="password" aria-describedby={describedBy} minLength={MIN_PASSWORD_LENGTH} value={form.password} autoComplete="new-password" onChange={(event) => setForm({ ...form, password: event.target.value })} required />
            )}
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-ink">Role</span>
            <Segmented
              label="Role"
              value={form.role}
              onChange={(role) => setForm({ ...form, role })}
              options={[
                { value: "user", label: "User" },
                { value: "admin", label: "Admin" },
              ]}
              className="self-start"
            />
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
