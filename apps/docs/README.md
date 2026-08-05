# Anvil documentation site

The public documentation is an Astro + Starlight application published at
<https://vamsiramakrishnan.github.io/anvil/>.

## Where content lives

The site combines two content sources:

- curated onboarding and cookbook pages in `apps/docs/src/content/docs`; and
- canonical repository documents in `docs/` and `skills/`, copied into the site
  by `scripts/sync-content.mjs` before development and builds.

Generated sections under `src/content/docs/concepts`, `guides`, `design`, and
`reference` are gitignored. Edit their source file in `docs/` or `skills/`, not
the generated copy.

The sync step also rewrites repository-relative links. Links to another
published document become site routes; links to non-published source files
become GitHub links. This lets canonical Markdown remain useful on GitHub
without breaking after it is moved into the Starlight content tree.

To publish another canonical page, add it to `PAGES` in
`scripts/sync-content.mjs`. ADRs under `docs/adr/` are discovered automatically.

## Develop locally

From the repository root:

```bash
corepack enable
pnpm install
pnpm --filter @anvil/air --filter @anvil/compiler build
pnpm --filter @anvil/docs dev
```

The compiler packages are built first because the browser playground imports
their real output.

## Validate

```bash
pnpm docs:check
pnpm --filter @anvil/docs build
```

`docs:check` syncs canonical content, requires title and description
frontmatter, and fails on unresolved local or site links. The build repeats the
check before Astro renders the site.

Cookbook shell blocks marked with `# [docs-tested]` are executed by
`packages/cli/src/cookbook-snippets.test.ts` in the main test suite. Mark only
deterministic, offline blocks and make cleanup part of the snippet.

## Information architecture

The sidebar is organized by developer intent:

1. Start
2. Build
3. Operate
4. Connect agents
5. Reference
6. Architecture

Keep a page in the earliest section that matches what the reader is trying to
do. Do not put release policy in the quickstart or introductory product prose in
the command reference.

## Writing standard

- Lead with the task outcome and prerequisites.
- Use exact command names and distinguish local planning from external action.
- Explain a refusal before telling the reader how to override or satisfy it.
- Prefer one canonical explanation and link to it from shorter pages.
- Avoid mutable test counts, benchmark totals, dates, and implementation-status
  claims unless they are generated from code.
- Keep secrets and real customer data out of examples.
- Use `status` as the recovery entrypoint when a workflow can be resumed.
- State format and provider boundaries explicitly; do not imply support from a
  parser seam or generated placeholder.

## Deploy

`.github/workflows/deploy-docs.yml` builds the compiler packages, validates the
site, and publishes `apps/docs/dist` to GitHub Pages after relevant changes land
on `main`. The repository's Pages source must be set to GitHub Actions.
