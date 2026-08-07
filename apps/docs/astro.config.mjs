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
      // Organize by the developer's task, not by the repository directory that
      // happens to own a page. Canonical docs keep stable routes while the
      // sidebar gives a progressive Start → Build → Operate path.
      sidebar: [
        {
          label: "Start",
          items: [
            { label: "Understand Anvil", slug: "start/what-is-anvil" },
            { label: "Install Anvil", slug: "cookbooks/install-anvil" },
            { label: "Quickstart", slug: "start/quickstart" },
            { label: "Adopt across a platform", slug: "start/for-enterprises" },
          ],
        },
        {
          label: "Build",
          items: [
            { label: "Source format support", slug: "guides/source-formats" },
            { label: "Write a manifest", slug: "guides/manifest" },
            { label: "Enrich and approve", slug: "guides/enrich-approve-workflow" },
            { label: "Import a gateway estate", slug: "cookbooks/import-a-gateway-estate" },
            { label: "Enrich a SOAP service", slug: "cookbooks/enrich-a-soap-service" },
            { label: "Cut context cost", slug: "cookbooks/cut-agent-context-cost" },
          ],
        },
        {
          label: "Legacy systems",
          items: [
            { label: "Understand legacy estates", slug: "concepts/legacy-estates" },
            { label: "Plan and inventory", slug: "guides/legacy-inventory" },
            { label: "Refine one candidate", slug: "guides/legacy-refinement" },
            { label: "Use the TypeScript SDK", slug: "guides/legacy-sdk" },
            {
              label: "Design a runtime bridge",
              slug: "concepts/legacy-runtime-bridges",
            },
          ],
        },
        {
          label: "Operate",
          items: [
            { label: "Operating Anvil", slug: "guides/operating-anvil" },
            { label: "Run Anvil in CI", slug: "guides/ci" },
            { label: "Troubleshooting", slug: "guides/troubleshooting" },
            { label: "Respond to spec drift", slug: "cookbooks/respond-to-drift" },
            {
              label: "Handle confirmation refusal",
              slug: "cookbooks/handle-confirmation-required",
            },
            { label: "Require human approval", slug: "cookbooks/require-human-approval" },
            {
              label: "Prove durable idempotency",
              slug: "cookbooks/prove-durable-idempotency",
            },
          ],
        },
        {
          label: "Connect agents",
          items: [
            { label: "Refine with a coding harness", slug: "guides/refinement-sdk" },
            { label: "Gemini Enterprise", slug: "cookbooks/connect-gemini-enterprise" },
            { label: "Claude Code plugin", slug: "cookbooks/install-claude-code-plugin" },
            { label: "Codex hook", slug: "cookbooks/wire-codex-hook" },
            { label: "Antigravity hook", slug: "cookbooks/wire-antigravity-hooks" },
            { label: "Hook decision flow", slug: "explore/decision-flow" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Command reference", slug: "guides/commands" },
            { label: "Example bundle", slug: "explore/example-bundle" },
            { label: "Errors and recovery", slug: "explore/errors" },
            { label: "Glossary", slug: "concepts/glossary" },
          ],
        },
        {
          label: "Architecture",
          collapsed: true,
          items: [
            { label: "Architecture", slug: "concepts/architecture" },
            { label: "Product boundary", slug: "concepts/product-boundary" },
            { label: "Mechanisms", slug: "concepts/mechanisms" },
            { label: "Gateway estates", slug: "concepts/gateway-estates" },
            {
              label: "Simulation and backtesting",
              slug: "concepts/simulation-and-backtesting",
            },
            { label: "Legacy GitHub corpus", slug: "concepts/legacy-corpus" },
            { label: "Hooks and plugins", slug: "design/hooks-and-plugins" },
            {
              label: "Investigation architecture",
              slug: "design/investigation-architecture",
            },
            {
              label: "Architecture decisions",
              collapsed: true,
              autogenerate: { directory: "reference/adr" },
            },
          ],
        },
      ],
    }),
  ],
  vite: {
    plugins: [anvilBrowserShims()],
  },
});
