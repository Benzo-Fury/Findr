import { useState, useEffect, useCallback } from "react"
import { Navigate } from "react-router-dom"
import { Plus } from "lucide-react"
import { auth } from "@/lib/auth"
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

  return (
    <div className="max-w-[1600px] mx-auto p-4 md:p-6 lg:p-8">
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-findr-text mb-1">
            Job Queue
          </h1>
          <p className="text-findr-secondary text-sm font-medium">
            Monitor and manage automated indexing tasks.
          </p>
        </div>

        <SearchDialog
          onJobCreated={fetchJobs}
          trigger={
            <button className="w-full md:w-auto h-10 px-4 bg-white border border-findr-border hover:border-findr-amber hover:text-findr-amber text-findr-text font-bold text-sm rounded-lg flex items-center justify-center gap-2 transition-colors shadow-sm">
              <Plus className="size-[18px]" />
              Manual Job
            </button>
          }
        />
      </div>

      <JobList jobs={jobs} loading={loadingJobs} onJobDeleted={fetchJobs} />
    </div>
  )
}
