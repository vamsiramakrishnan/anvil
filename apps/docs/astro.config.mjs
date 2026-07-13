import { fileURLToPath } from "node:url";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { REPO_URL, SITE_BASE, SITE_DESCRIPTION, SITE_TITLE, SITE_URL } from "./src/lib/site-meta.mjs";

// ---------------------------------------------------------------------------
// Compile-playground wiring: serve the real @anvil/compiler to the browser
// (/anvil/playground). The compiler's tsup bundle imports node builtins
// (crypto for hashing; fs/path from the Layer-0 snapshot store that the
// string-compile path never calls) and swagger2openapi (node-only Swagger 2.0
// conversion). A resolveId plugin swaps those for local shims — CLIENT BUILD
// ONLY, so the SSR/build pipeline (Astro/Starlight themselves) keeps the real
// builtins. Requires @anvil/air + @anvil/compiler to be BUILT first (the
// deploy workflow does this); see docs/design/playground-spike.md.
// ---------------------------------------------------------------------------
const local = (p) => fileURLToPath(new URL(p, import.meta.url));
const BROWSER_SHIMS = {
  "@anvil/compiler": local("../../packages/compiler/dist/index.js"),
  "@anvil/air": local("../../packages/air/dist/index.js"),
  crypto: local("./src/shims/node-crypto.js"),
  "node:crypto": local("./src/shims/node-crypto.js"),
  path: local("./src/shims/node-path.js"),
  "node:path": local("./src/shims/node-path.js"),
  fs: local("./src/shims/node-fs.js"),
  "node:fs": local("./src/shims/node-fs.js"),
  "fs/promises": local("./src/shims/node-fs-promises.js"),
  "node:fs/promises": local("./src/shims/node-fs-promises.js"),
  swagger2openapi: local("./src/shims/swagger2openapi.js"),
};

function anvilBrowserShims() {
  return {
    name: "anvil-browser-shims",
    enforce: "pre",
    resolveId(source, _importer, options) {
      if (options?.ssr) return null; // never touch the node-side build
      return BROWSER_SHIMS[source] ?? null;
    },
  };
}

// Anvil's documentation website. Content is NOT authored here — the curated
// pages (landing, Start Here) live in src/content/docs, and everything else is
// rendered from the repo's canonical docs/ + skills/ markdown by
// scripts/sync-content.mjs before every dev/build (see package.json). docs/
// stays the single source of truth; this app is presentation only: theme,
// information architecture, and the landing page.
//
// The theme is the "Modernist Functionalism" (Braun/Dieter Rams) system from
// vamsiramakrishnan/ge-agent-factory — src/styles/custom.css is that project's
// brand layer, reused verbatim (accent #00408b, Hanken Grotesk + JetBrains
// Mono, hairline borders, github-dark code).
export default defineConfig({
  site: SITE_URL,
  base: SITE_BASE,
  integrations: [
    starlight({
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
      favicon: "/favicon.svg",
      customCss: ["./src/styles/custom.css"],
      components: {
        // The header wordmark: an accent monogram plate + "anvil" logotype,
        // reusing the theme's .ge-wordmark lockup.
        SiteTitle: "./src/components/SiteTitle.astro",
      },
      social: [{ icon: "github", label: "GitHub", href: REPO_URL }],
      // Synced pages carry a per-page `editUrl` pointing back at their docs/
      // source; this is the fallback for the curated pages.
      editLink: { baseUrl: `${REPO_URL}/edit/main/apps/docs/` },
      expressiveCode: {
        // One dark theme in BOTH site themes: code is terminal content, so it
        // always renders behind the instrument's black readout glass (the
        // theme's Punktraster design language — see custom.css .expressive-code).
        themes: ["github-dark"],
        styleOverrides: { borderRadius: "0.5rem" },
      },
      sidebar: [
        { label: "Start Here", autogenerate: { directory: "start" } },
        { label: "Concepts", autogenerate: { directory: "concepts" } },
        { label: "Cookbooks", autogenerate: { directory: "cookbooks" } },
        { label: "Guides", autogenerate: { directory: "guides" } },
        { label: "Explore the output", autogenerate: { directory: "explore" } },
        { label: "Design", autogenerate: { directory: "design" } },
        { label: "Architecture Decisions", autogenerate: { directory: "reference/adr" } },
      ],
    }),
  ],
  vite: {
    plugins: [anvilBrowserShims()],
  },
});
