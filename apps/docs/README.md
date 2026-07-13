# Anvil documentation website

Astro + [Starlight](https://starlight.astro.build/) site for Anvil, published to
GitHub Pages at <https://vamsiramakrishnan.github.io/anvil/>.

## The idea: docs/ is the source of truth

This app is **presentation only**. The curated pages (the landing page and
`Start Here`) live in `src/content/docs`; everything else is rendered from the
repo's canonical `docs/` and `skills/` markdown by `scripts/sync-content.mjs`,
which runs before every `dev`/`build`. The synced sections
(`concepts/`, `guides/`, `design/`, `reference/`) are gitignored — **edit the
source markdown in `docs/` and `skills/`, not the generated pages.**

To add a page to the site, add an entry to the `PAGES` map in
`scripts/sync-content.mjs` (or drop a new ADR in `docs/adr/`, which is picked up
automatically).

## Theme

The look is the "Modernist Functionalism" (Braun / Dieter Rams) design system
from [`vamsiramakrishnan/ge-agent-factory`](https://github.com/vamsiramakrishnan/ge-agent-factory):
`src/styles/custom.css` is that project's brand layer reused verbatim — accent
`#00408b`, Hanken Grotesk + JetBrains Mono, hairline borders, `github-dark` code.
Only the wordmark (`src/components/SiteTitle.astro`), favicon, and content are
Anvil's.

## Develop

This app is intentionally **outside** the pnpm workspace, so installing the core
Anvil toolchain never pulls in Astro. Install and run it on its own:

```bash
cd apps/docs
pnpm install
pnpm dev      # syncs content, then astro dev
pnpm build    # syncs content, then astro build → dist/
pnpm preview
```

## Deploy

`.github/workflows/deploy-docs.yml` builds this app and publishes `dist/` to
GitHub Pages on any push to `main` that touches `docs/`, `skills/`, or
`apps/docs/`. The repo's **Pages source must be set to "GitHub Actions"** for the
workflow to take effect.
