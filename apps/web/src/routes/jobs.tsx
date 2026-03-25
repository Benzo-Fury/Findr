import { useState, useEffect, useCallback } from "react"
import { useNavigate, Navigate, NavLink } from "react-router-dom"
import { LogOut } from "lucide-react"
import { auth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { SearchDialog } from "@/components/search-dialog"
import { JobList } from "@/components/job-list"

interface Job {
  id: string
  imdbId: string
  season: number | null
  status: { primary: string; message?: string }
  preferences?: {
    resolutions: string[]
    maxFileSizeGB: number
    minSeeders: number
    blacklistedReleaseTypes: string[]
  } | null
  createdAt: string
  updatedAt: string
}

export default function Jobs() {
  const navigate = useNavigate()
  const { data: session, isPending } = auth.useSession()
  const [jobs, setJobs] = useState<Job[]>([])
  const [loadingJobs, setLoadingJobs] = useState(true)

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs", { credentials: "include" })
      if (res.ok) {
        const data = await res.json()
        setJobs(Array.isArray(data) ? data : data.jobs ?? [])
      }
    } catch {
      // silently fail
    } finally {
      setLoadingJobs(false)
    }
  }, [])

  useEffect(() => {
    if (!session) return
    fetchJobs()
    const interval = setInterval(fetchJobs, 5000)
    return () => clearInterval(interval)
  }, [session, fetchJobs])

  if (isPending) return null
  if (!session) return <Navigate to="/login" replace />

  async function handleSignOut() {
    await auth.signOut()
    navigate("/login")
  }

  return (
    <div className="mx-auto min-h-screen max-w-2xl px-4 py-8">
      <header className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <h1 className="text-xl font-bold tracking-tight">Findr</h1>
          <nav className="flex items-center gap-4">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                `text-sm transition-colors ${isActive ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`
              }
            >
              Library
            </NavLink>
            <NavLink
              to="/jobs"
              className={({ isActive }) =>
                `text-sm transition-colors ${isActive ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`
              }
            >
              Jobs
            </NavLink>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <SearchDialog onJobCreated={fetchJobs} />
          <Button variant="ghost" size="icon" onClick={handleSignOut}>
            <LogOut className="size-4" />
          </Button>
        </div>
      </header>

      <section>
        <JobList jobs={jobs} loading={loadingJobs} />
      </section>
    </div>
  )
}
