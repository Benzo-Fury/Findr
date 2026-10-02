import * as React from "react"
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom"
import { MotionConfig } from "motion/react"
import { isAdmin, mustReset, useSession } from "@/lib/auth"
import { LibraryProvider } from "@/lib/library"
import { AppShell } from "@/components/shell/app-shell"
import { Brand } from "@/components/shell/brand"
import { ToastProvider } from "@/components/ui/toast"
import { LibraryPage } from "@/pages/library"

// Library is the landing page; the rest load on first visit
const DiscoverPage = React.lazy(() => import("@/pages/discover").then((module) => ({ default: module.DiscoverPage })))
const DownloadsPage = React.lazy(() => import("@/pages/downloads").then((module) => ({ default: module.DownloadsPage })))
const SettingsPage = React.lazy(() => import("@/pages/settings").then((module) => ({ default: module.SettingsPage })))
const LoginPage = React.lazy(() => import("@/pages/login").then((module) => ({ default: module.LoginPage })))
const CredentialsPage = React.lazy(() => import("@/pages/credentials").then((module) => ({ default: module.CredentialsPage })))

/**
 * Routing, split by whether there is a session.
 *
 * Signed out, the only reachable page is sign-in; accounts are created by an
 * admin, so there is no registration route. The initial admin, still on
 * `admin` / `admin`, sees only the screen that replaces those credentials.
 * Signed in, every page shares the shell, and any page can show a title
 * through the `?t=` parameter. Motion honours the system's reduced-motion
 * setting everywhere.
 */
function App() {
  const { data: session, isPending } = useSession()

  return (
    <MotionConfig reducedMotion="user">
      <React.Suspense fallback={<Splash />}>
      {isPending ? (
        <Splash />
      ) : !session ? (
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </BrowserRouter>
      ) : mustReset(session) ? (
        <CredentialsPage />
      ) : (
        <BrowserRouter>
          <LibraryProvider>
            <ToastProvider>
              <Routes>
                <Route element={<AppShell session={session} />}>
                  <Route index element={<LibraryPage />} />
                  <Route path="/discover" element={<DiscoverPage />} />
                  <Route path="/discover/:mediaType/:id" element={<LegacyTitleLink />} />
                  <Route path="/downloads" element={<DownloadsPage />} />
                  <Route path="/downloads/:id" element={<DownloadsPage />} />
                  {isAdmin(session) && <Route path="/settings" element={<SettingsPage />} />}
                </Route>
                <Route path="/login" element={<Navigate to="/" replace />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </ToastProvider>
          </LibraryProvider>
        </BrowserRouter>
      )}
      </React.Suspense>
    </MotionConfig>
  )
}

/** Older title links (`/discover/movie/603`) open the same title in the sheet. */
function LegacyTitleLink() {
  const { mediaType, id } = useParams()
  const valid = (mediaType === "movie" || mediaType === "tv") && /^\d+$/.test(id ?? "")
  return <Navigate to={valid ? `/discover?t=${mediaType}:${id}` : "/discover"} replace />
}

/** Shown for the moment it takes to read the session. */
function Splash() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center">
      <Brand className="animate-pulse" />
    </div>
  )
}

export default App
