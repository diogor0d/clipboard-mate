import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    // The shared contracts package exports TypeScript source. Bundle it and
    // Zod so the packaged main process never relies on TS under node_modules.
    plugins: [
      externalizeDepsPlugin({ exclude: ["@clipboard-mate/contracts", "zod"] }),
    ],
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({ exclude: ["@clipboard-mate/contracts", "zod"] }),
    ],
    build: {
      // Sandboxed Electron preload scripts run as CommonJS, not native ESM.
      rollupOptions: { output: { format: "cjs" } },
    },
  },
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
      },
    },
    plugins: [react()],
  },
});
