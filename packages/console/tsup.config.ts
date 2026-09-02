import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  // `dist/ui` belongs to vite (`vite build` empties and refills it); tsup
  // cleans everything else in `dist` and leaves the UI build alone.
  clean: ["!ui/**"],
  sourcemap: true,
  target: "es2023",
});
