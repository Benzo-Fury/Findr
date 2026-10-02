import type * as React from "react"
import { MediaGrid } from "@/components/media-grid"

/**
 * The full-screen frame around the screens shown before the app proper: a
 * poster backdrop with the Findr mark and one card on top. Used by sign-in
 * and by the initial admin's credential reset.
 */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-svh overflow-hidden bg-black">
      <MediaGrid />
      <div className="relative z-30 flex min-h-svh items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-background/90 p-8 shadow-2xl backdrop-blur-md">
          <div className="mb-8 flex items-center justify-center gap-2">
            <img src="/findr-logo.svg" alt="Findr" className="size-7" />
            <span className="text-lg font-bold" style={{ color: "oklch(0.77 0.165 70)" }}>
              Findr
            </span>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}
