import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * The console UI build. `src/ui` is the vite root and `dist/ui` its output —
 * tsup owns the rest of `dist` (and is told not to clean `dist/ui`), so the
 * two builds never clobber each other. `base: "./"` because the server serves
 * the one page from whatever path it likes.
 *
 * In dev (`pnpm dev`) the contract mock answers `/api/*` from in-process
 * fixtures that are parsed through `contract.ts` on every response, so the UI
 * is developed against the contract, never against a particular server.
 *
 * Loading this file must have no side effects. The mock imports `contract.ts`,
 * which imports the `@anvil/*` package entry points — built artifacts that do
 * not exist on a fresh checkout. knip evaluates this config before anything
 * is built, and `vite build` and vitest load it too, so the mock is imported
 * lazily inside `configureServer`, the one hook that only runs for `pnpm dev`.
 * `vite-config.test.ts` (src/ui/dev) proves the contract stays unloaded.
 */
type MockConsole = ReturnType<typeof import("./src/ui/dev/mock-server.js").createMockConsole>;

function mockApi(): Plugin {
  let mock: MockConsole | undefined;
  return {
    name: "anvil-console-mock-api",
    apply: "serve",
    // Exactly what the real server does to the built page (src/server/http.ts).
    // The mock is minted in `configureServer`, which vite runs before any page
    // is served; an empty token here means the dev server has not started.
    transformIndexHtml(html) {
      const token = mock?.token ?? "";
      return html.replace("<head>", `<head><meta name="anvil-console-token" content="${token}">`);
    },
    async configureServer(server) {
      const { createMockConsole } = await import("./src/ui/dev/mock-server.js");
      const instance = createMockConsole();
      mock = instance;
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "/";
        if (!url.startsWith("/api/")) return next();
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const result = instance.handle({
            method: req.method ?? "GET",
            url,
            body: body.length > 0 ? body : undefined,
            headers: {
              "x-anvil-console-token": String(req.headers["x-anvil-console-token"] ?? ""),
              "content-type": String(req.headers["content-type"] ?? ""),
            },
          });
          res.statusCode = result.status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(result.body));
        });
      });
    },
  };
}

export default defineConfig({
  root: "src/ui",
  base: "./",
  plugins: [react(), mockApi()],
  build: {
    outDir: "../../dist/ui",
    emptyOutDir: true,
    sourcemap: false,
    rolldownOptions: {
      // The contract's zod schemas are re-exported through the `@anvil/*`
      // package entry points, which also export the build-time machinery
      // (parsers, generators, node:fs readers). Nothing in those modules
      // registers itself on import, so unused ones are dropped whole and the
      // page ships the schemas it parses with and nothing else.
      //
      // Verified (lane 4): every top-level statement in air, compiler,
      // generators, refinement, and design is a declaration or export. The
      // only top-level `process.*` calls under generators/src sit inside the
      // template literals of plugins.ts and entrypoints.ts — text the
      // generators write into a bundle, never code that runs here. The CSS
      // entries main.tsx imports (`@anvil/design/tokens.css`, the fonts,
      // styles.css) go through vite's CSS pipeline, which this flag does not
      // govern: dist/ui carries the stylesheet. So the whole-tree flag stays;
      // a per-package `sideEffects: false` would say the same thing in five
      // places and drift.
      treeshake: { moduleSideEffects: false },
    },
  },
});
