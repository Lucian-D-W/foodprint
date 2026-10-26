import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const tauriDevHost = process.env.TAURI_DEV_HOST;
const tauriPlatform = process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    assetsInlineLimit: 0,
    target: tauriPlatform === "windows" ? "chrome105" : tauriPlatform ? "safari13" : "es2021",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
  server: {
    host: tauriDevHost || false,
    port: 5173,
    strictPort: true,
    hmr: tauriDevHost
      ? {
          protocol: "ws",
          host: tauriDevHost,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
