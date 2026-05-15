import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  clean: true,
  dts: false,
  format: ["esm"],
  sourcemap: true,
  splitting: false,
  target: "node20",
  outDir: "dist",
  banner: {
    js: "#!/usr/bin/env node",
  },
});
