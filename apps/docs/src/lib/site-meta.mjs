// The site's identity, shared by astro.config.mjs (the Starlight header) and any
// future llms.txt endpoints — one source, no hand-mirrored copies.
export const SITE_TITLE = "Anvil";
export const SITE_DESCRIPTION =
  "Anvil is an agent toolchain compiler: it compiles one API specification into aligned CLI + MCP server + skill + hook artifacts, with structured errors, retry/idempotency safety, and an approval workflow.";

// GitHub Pages coordinates. `site` + `base` produce the published URL
// https://vamsiramakrishnan.github.io/anvil/ and every absolute link the theme
// builds. Change `base` if the repo (and thus the Pages path) is renamed.
export const SITE_URL = "https://vamsiramakrishnan.github.io";
export const SITE_BASE = "/anvil";
export const REPO_URL = "https://github.com/vamsiramakrishnan/anvil";
