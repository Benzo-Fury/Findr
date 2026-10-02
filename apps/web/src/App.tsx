import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import { LoginPage } from "@/components/login-form"
import { CredentialsPage } from "@/components/credentials-form"
import { AppLayout } from "@/components/app-layout"
import { LibraryPage } from "@/pages/library"
import { DiscoverPage } from "@/pages/discover"
import { DownloadsPage } from "@/pages/downloads"
import { SettingsPage } from "@/pages/settings"
import { isAdmin, mustReset, useSession } from "@/lib/auth"

/**
 * Routing, split by whether there is a session.
 *
 * Signed out, the only reachable page is the login screen — accounts are
 * created out of band, so there is no registration route to fall through to.
 * The initial admin, still on `admin` / `admin`, sees only the screen that
 * replaces those credentials; the server refuses it everything else.
 * The app is served from the root of the API, so no router basename is needed.
 */
function App() {
  const { data: session, isPending } = useSession()

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="size-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      </div>
    )
  }

  if (!session) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>
    )
  }

  if (mustReset(session)) {
    return <CredentialsPage />
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout session={session} />}>
          <Route index element={<LibraryPage />} />
          <Route path="/discover" element={<DiscoverPage />} />
          <Route path="/discover/:mediaType/:id" element={<DiscoverPage />} />
          <Route path="/downloads" element={<DownloadsPage />} />
          <Route path="/downloads/:id" element={<DownloadsPage />} />
          {isAdmin(session) && <Route path="/settings" element={<SettingsPage />} />}
        </Route>
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
