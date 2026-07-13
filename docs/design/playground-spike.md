# Spike: in-browser compile playground for the docs site

**Verdict: FEASIBLE** — the real `@anvil/compiler` runs client-side today, with
four small shims and zero compiler changes. The browser bundle's classification
output (effect / risk / idempotency / confirmation) is **byte-identical** to
the node compiler's, including the content-derived `sourceHash`.

- Page: `/anvil/playground` (apps/docs `src/pages/playground.astro`,
  rendered inside Starlight chrome via `StarlightPage`).
- `pnpm astro build` succeeds; the compiler ships as one lazily-loaded chunk:
  **691 KB raw / 190 KB gzip** (`dist/_astro/index.*.js`), loaded only when
  the user clicks Compile. The page script itself is 3.7 KB.
- Smoke-tested by importing the *built browser chunk* and comparing against
  `packages/compiler/dist/index.js` on the same spec:
  `PARITY with node compiler: IDENTICAL`, `sourceHash parity: true`.

## Blockers found (exact errors) and how each was cleared

Bundling `packages/compiler/dist/index.js` for the browser with **no**
mitigations fails immediately:

```
[plugin vite:resolve] Module "path" has been externalized for browser compatibility, imported by ".../packages/compiler/dist/index.js".
[plugin vite:resolve] Module "crypto" has been externalized ... (also "fs", "fs/promises")
[plugin vite:resolve] Module "fs" / "url" / "path" / "http" ... imported by swagger2openapi/index.js, oas-resolver/index.js, swagger2openapi/lib/statusCodes.js
error during build:
.../packages/air/dist/index.js (136:9): "createHash" is not exported by "__vite-browser-external",
imported by ".../packages/air/dist/index.js".
    136: import { createHash } from "crypto";
```

1. **`node:crypto` (`createHash`, sync)** — used on the real compile path
   (`computeSourceHash` for the ephemeral source, `hashCanonical` in
   capability contracts). SubtleCrypto is async-only, so the shim is a small
   pure-JS SHA-256 (`src/shims/node-crypto.js`), verified digest-for-digest
   against node's `crypto` (9 vectors incl. multi-`update()` and padding
   boundaries: `ALL HASHES MATCH`). `randomBytes` → `crypto.getRandomValues`
   (only linked, never called, from the snapshot store).
2. **`node:path`** — the compile-from-string path only calls
   `posix.normalize/dirname/join` (parse.ts, wsdl.ts) plus `basename`
   (compiler-source.ts) and `extname` (detect.ts). A ~90-line posix shim
   (`src/shims/node-path.js`) covers the full linked surface
   (`resolve`/`relative`/`sep` included so the bundle links).
3. **`node:fs` + `node:fs/promises` (`glob`)** — bundled because the package
   index re-exports the Layer-0 snapshot store (`source/store.ts`,
   `source/import.ts`), but never called when compiling from a string.
   Throwing stubs (`src/shims/node-fs.js`, `node-fs-promises.js`) so any
   accidental filesystem reach is loud.
4. **`swagger2openapi`** — statically imported by `parse.ts` but only invoked
   for Swagger 2.0 documents. Its dependency graph (oas-resolver, node-fetch,
   `http`, yargs) is hopeless in a browser. Stubbed
   (`src/shims/swagger2openapi.js`): OpenAPI 3.x compiles fully; pasting a
   Swagger 2.0 doc yields a clear error
   ("Swagger 2.0 conversion is not available in the browser playground —
   paste an OpenAPI 3.x document instead."). Restoring 2.0 support would be
   the one real follow-up (a browser-safe converter or a compiler-side
   dynamic import).

## Non-blockers (checked, fine in the browser)

- `yaml`, `zod`, `@scalar/openapi-parser`, `graphql`, `fast-xml-parser`,
  `protobufjs` all bundle clean — the final chunk has **zero** residual
  external imports.
- No `Buffer`, no `process.*`, no top-level await in either dist bundle
  (grep-verified). Text decode uses `TextDecoder`/`TextEncoder`.
- GraphQL SDL and .proto specs should also classify in-browser (their
  adapters bundled without complaint); not smoke-tested.

## The one sharp edge: shims must be client-build-only

Naively adding `fs`/`path`/`crypto` to `vite.resolve.alias` would also rewrite
Astro/Starlight's **SSR** build (which legitimately uses node builtins) and
break the site build. The fix is a tiny vite plugin whose `resolveId` bails
when `options.ssr` is true — shims apply to the browser graph only. This is
the load-bearing trick; keep it if productionizing.

## Minimal diff to reproduce (all in apps/docs)

1. `astro.config.mjs` — add the `anvilBrowserShims()` resolveId plugin
   (client-only) mapping `@anvil/compiler`, `@anvil/air`, `crypto`, `path`,
   `fs`, `fs/promises` (both bare and `node:`-prefixed forms — the tsup dist
   emits bare specifiers) and `swagger2openapi` to dist paths / local shims,
   and register it under `vite.plugins`.
2. `src/shims/node-crypto.js` — sync pure-JS SHA-256 `createHash` +
   `randomBytes`.
3. `src/shims/node-path.js` — posix path subset.
4. `src/shims/node-fs.js`, `src/shims/node-fs-promises.js` — throwing stubs.
5. `src/shims/swagger2openapi.js` — throwing `convertObj` stub.
6. `src/pages/playground.astro` — textarea + Compile button; the client
   script dynamic-imports `@anvil/compiler` (so the 190 KB gz chunk is
   deferred) and renders id / method+path / effect.kind+action / risk /
   reversible / idempotency mode+mechanism / confirmation into a table styled
   with the site's `--sl-*` / `--ge-*` vars. Note: the sample spec is set
   from the script, **not** inline in the markup — Astro parses `{payment_id}`
   path templates as template expressions (`is:raw` on the textarea did not
   suppress it; build error "payment_id is not defined").

No changes to `package.json` were needed (no new deps); no compiler changes.

## Productionizing notes (beyond the spike)

- The spike aliases `@anvil/compiler`/`@anvil/air` to **absolute main-tree**
  `dist/` paths (`ANVIL_ROOT = /home/user/anvil`). For CI, build the two
  workspace packages first and point at repo-relative paths
  (`../../packages/compiler/dist/index.js`), or publish and install them.
- The 691 KB chunk could shrink meaningfully by importing a narrower entry
  than the package index (the index re-exports adopt/gateway/contract/store —
  much of it dead weight for the playground), but tree-shaking already keeps
  it acceptable and code-splitting hides the cost until first Compile.
- Sample compile output (the prefilled Payments spec):
  `payments.create` → mutation / financial / irreversible / confirm;
  `payments.delete` → mutation / destructive / confirm;
  `payments.list` → read / none / natural idempotency — i.e. the exact
  `anvil compile` classification, in the browser.
