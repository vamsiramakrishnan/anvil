import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { REPO_URL, SITE_BASE, SITE_DESCRIPTION, SITE_TITLE, SITE_URL } from "./src/lib/site-meta.mjs";

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
});
