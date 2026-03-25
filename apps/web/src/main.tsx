import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Routes, Route, Outlet } from "react-router-dom"
import "@/index.css"
import { AppHeader } from "@/components/app-header"
import Home from "@/routes/home"
import Discover from "@/routes/discover"
import Jobs from "@/routes/jobs"
import Login from "@/routes/login"
import Signup from "@/routes/signup"

function AppLayout() {
  return (
    <>
      <AppHeader />
      <main className="pt-16 min-h-screen">
        <Outlet />
      </main>
    </>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Home />} />
          <Route path="/discover" element={<Discover />} />
          <Route path="/jobs" element={<Jobs />} />
        </Route>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
