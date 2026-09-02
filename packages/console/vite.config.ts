import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { createMockConsole } from "./src/ui/dev/mock-server.js";

/**
 * The console UI build. `src/ui` is the vite root and `dist/ui` its output —
 * tsup owns the rest of `dist` (and is told not to clean `dist/ui`), so the
 * two builds never clobber each other. `base: "./"` because the server serves
 * the one page from whatever path it likes.
 *
 * In dev (`pnpm dev`) the contract mock answers `/api/*` from in-process
 * fixtures that are parsed through `contract.ts` on every response, so the UI
 * is developed against the contract, never against a particular server.
 */
function mockApi(): Plugin {
  const mock = createMockConsole();
  return {
    name: "anvil-console-mock-api",
    apply: "serve",
    // Exactly what the real server does to the built page (src/server/http.ts).
    transformIndexHtml(html) {
      return html.replace("<head>", `<head><meta name="anvil-console-token" content="${mock.token}">`);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "/";
        if (!url.startsWith("/api/")) return next();
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const result = mock.handle({
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
      treeshake: { moduleSideEffects: false },
    },
  },
});
