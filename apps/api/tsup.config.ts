import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    server: "src/server.ts",
    "cli/create-device": "src/cli/create-device.ts",
    "cli/revoke-device": "src/cli/revoke-device.ts",
  },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  // The contracts package exports TypeScript source. Bundle it into each API
  // entry point so the production image never needs a TypeScript loader.
  noExternal: ["@clipboard-mate/contracts"],
});
