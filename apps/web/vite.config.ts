import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "path"

const dirname = import.meta.dirname

/**
 * The app is served from the root of the API in both environments — Vite's
 * dev server behind the API's proxy, and in production the files the API build
 * embeds from `apps/web/dist/` — so there is no base path to configure. Static
 * assets in `public/` are copied into that same output directory.
 */
export default defineConfig({
  plugins: [tailwindcss(), react()],
  build: {
    outDir: path.resolve(dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // The API's default port; follow Settings → Access if it is changed
      "/api": "http://localhost:34571",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(dirname, "./src"),
    },
  },
})
