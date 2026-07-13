// Logic behind the /llms.txt and /llms-full.txt endpoints (src/pages/*.txt.js):
// turn the docs content collection (curated .mdx + pages synced from docs/ and
// skills/ by scripts/sync-content.mjs) into plain, LLM-legible markdown in a
// deterministic order. Pure functions — no astro imports — so this file passes
// `node --check` and could be unit-tested directly.
//
// Ported from vamsiramakrishnan/ge-agent-factory apps/docs, adapted to Anvil:
// the fence/inline-code shelter helpers are inlined (Anvil has no
// scripts/lib/mdx-transform.mjs), and the section order mirrors the sidebar in
// this app's astro.config.mjs.

// Mirrors the sidebar group order in astro.config.mjs (Starlight's sidebar
// config shape can't be shared directly). The landing page sorts into
// "Start Here"; unknown future top-level segments sort last, alphabetically.
const SECTION_ORDER = ["start", "concepts", "cookbooks", "guides", "explore", "design", "reference/adr"];
const SECTION_LABELS = {
  start: "Start Here",
  concepts: "Concepts",
  cookbooks: "Cookbooks",
  guides: "Guides",
  explore: "Explore the output",
  design: "Design",
  "reference/adr": "Architecture Decisions",
  reference: "Reference",
};

const ASIDE_LABELS = { note: "Note", tip: "Tip", caution: "Caution", danger: "Important" };

export function sectionOf(id) {
  const slug = String(id ?? "");
  if (slug === "index" || slug === "") return "start";
  if (slug.startsWith("reference/adr/") || slug === "reference/adr") return "reference/adr";
  return slug.split("/")[0];
}

export function sectionLabelOf(id) {
  const section = sectionOf(id);
  return SECTION_LABELS[section] ?? section.charAt(0).toUpperCase() + section.slice(1);
}

function sectionRank(id) {
  const i = SECTION_ORDER.indexOf(sectionOf(id));
  return i === -1 ? SECTION_ORDER.length : i;
}

function orderKey(page) {
  if (page.id === "index") return -1; // the landing page leads its section
  const order = page.data?.sidebar?.order;
  return Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER;
}

// Deterministic page order: sidebar section (astro.config order), then the
// page's sidebar order, then slug — no dependence on filesystem enumeration.
export function orderPages(pages) {
  return [...pages].sort((a, b) => {
    const rank = sectionRank(a.id) - sectionRank(b.id);
    if (rank !== 0) return rank;
    const order = orderKey(a) - orderKey(b);
    if (order !== 0) return order;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// Published = has parseable frontmatter (a data object) and is not a draft.
// Malformed pages fail Starlight's schema before they ever reach us, but keep
// the guard so a partially-loaded entry can't crash the whole endpoint.
export function isPublished(entry) {
  return Boolean(entry && typeof entry.id === "string" && entry.data) && entry.data.draft !== true;
}

export function siteRootFrom(site, base) {
  return `${String(site ?? "").replace(/\/+$/, "")}${String(base ?? "").replace(/\/+$/, "")}`;
}

export function urlFor(id, siteRoot) {
  return `${siteRoot}/${id === "index" ? "" : `${id}/`}`;
}

// ── code shelters ───────────────────────────────────────────────────────────
// plainifyMdx runs a pile of regex passes over prose; fenced blocks and inline
// code spans are swapped for opaque placeholders first so code samples pass
// through byte-identical. The placeholder alphabet (U+0000 NUL + digits) cannot be
// produced or altered by any of the prose passes below.

export function shelterFences(text) {
  const blocks = [];
  const sheltered = String(text ?? "").replace(
    /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1`*[ \t]*$/gm,
    (match) => {
      blocks.push(match);
      return `\u0000F${blocks.length - 1}\u0000`;
    },
  );
  return { sheltered, blocks };
}

export function restoreFences(text, blocks) {
  return text.replace(/\u0000F(\d+)\u0000/g, (_, i) => blocks[Number(i)] ?? "");
}

export function shelterInlineCode(text) {
  const spans = [];
  const sheltered = String(text ?? "").replace(/(`+)(?!`)[^`]+\1(?!`)/g, (match) => {
    spans.push(match);
    return `\u0000C${spans.length - 1}\u0000`;
  });
  return { sheltered, spans };
}

export function restoreInlineCode(text, spans) {
  return text.replace(/\u0000C(\d+)\u0000/g, (_, i) => spans[Number(i)] ?? "");
}

// ── body → plain markdown ───────────────────────────────────────────────────
// Synced pages are plain CommonMark (sync-content.mjs emits .md), so they pass
// through nearly untouched. The curated .mdx pages (landing, Start Here) are
// where the work is: ESM import lines, Starlight components (<Card>, <Tabs>,
// <LinkCard>), custom diagram components, and MDX escapes all come back out.
// Pass { base, siteRoot } to also absolutize base-relative page links
// (`](/anvil/…` → `](https://…/anvil/…`) so the file is legible off-site.
export function plainifyMdx(body, { base, siteRoot } = {}) {
  const { sheltered, blocks } = shelterFences(String(body ?? ""));
  const { sheltered: prose, spans } = shelterInlineCode(sheltered);
  let text = prose;

  // MDX ESM import lines (curated pages import Starlight/diagram components).
  text = text.replace(/^import\s[^\n]*from\s+['"][^'"]+['"];?[ \t]*$/gm, "");

  // Tooltip-style anchors → the plain term; other HTML anchors → markdown links.
  text = text.replace(/<a\s[^>]*\btitle="[^"]*"[^>]*>([\s\S]*?)<\/a>/g, "$1");
  text = text.replace(/<a\s[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, "[$2]($1)");

  // HTML images → markdown images; drop the <p align> wrappers around them.
  text = text.replace(/<img\s([^<>]*?)\/?>/g, (_, attrs) => {
    const src = attrs.match(/\bsrc="([^"]*)"/)?.[1] ?? "";
    const alt = attrs.match(/\balt="([^"]*)"/)?.[1] ?? "";
    return `![${alt}](${src})`;
  });
  text = text.replace(/<p\b[^>]*>|<\/p>/g, "");

  // Inline HTML emphasis → markdown; layout-only wrappers (the landing page's
  // <div class="ge-value-grid"> cells, <span> labels) drop away.
  text = text.replace(/<strong\b[^>]*>([\s\S]*?)<\/strong>/g, "**$1**");
  text = text.replace(/<em\b[^>]*>([\s\S]*?)<\/em>/g, "*$1*");
  text = text.replace(/<\/?(?:span|small|mark)\b[^>]*>/g, "");
  text = text.replace(/^[ \t]*<\/?(?:div|section|figure|figcaption|br|hr)\b[^>]*\/?>[ \t]*$/gm, "");

  // Starlight asides → a bold label line; the body stays as-is.
  text = text.replace(
    /^:::([a-z]+)(?:\[([^\]]*)\])?[ \t]*$/gm,
    (_, kind, label) => `**${label || ASIDE_LABELS[kind] || kind}:**`,
  );
  text = text.replace(/^:::[ \t]*$/gm, "");

  // Components that carry prose in their attributes keep it …
  text = text.replace(
    /^([ \t]*)<(?:TabItem|Card)\s[^>]*\b(?:label|title)="([^"]*)"[^>]*>[ \t]*$/gm,
    "$1**$2**",
  );
  text = text.replace(/<Badge\s([^<>]*?)\/>/g, (_, attrs) => {
    const label = attrs.match(/\btext="([^"]*)"/)?.[1];
    return label ? `**${label}**` : "";
  });
  text = text.replace(/<LinkCard\s([^<>]*?)\/>/g, (_, attrs) => {
    const title = attrs.match(/\btitle="([^"]*)"/)?.[1];
    const href = attrs.match(/\bhref="([^"]*)"/)?.[1];
    const description = attrs.match(/\bdescription="([^"]*)"/)?.[1];
    return title && href ? `- [${title}](${href})${description ? `: ${description}` : ""}` : "";
  });
  // … the rest (wrappers like <CardGrid>, <Steps>, </TabItem>, diagram
  // components such as <PipelineDiagram />) are presentation and drop away.
  text = text.replace(/^[ \t]*<\/?[A-Z][\w.]*(?:\s[^<>]*)?>[ \t]*$/gm, "");
  text = text.replace(/<\/?[A-Z][\w.]*(?:\s[^<>]*)?\/?>/g, "");

  // Undo MDX escapes and HTML entities that .mdx authoring forces on prose.
  text = text.replace(/\\\{/g, "{");
  text = text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

  if (base && siteRoot) {
    text = text.split(`](${String(base).replace(/\/+$/, "")}/`).join(`](${siteRoot}/`);
  }

  text = restoreInlineCode(text, spans);
  text = restoreFences(text, blocks);
  return `${text.replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

// First prose sentence of a plainified body — the llms.txt description for
// pages whose frontmatter doesn't provide one.
export function firstProseSentence(plain, max = 200) {
  const noFences = String(plain ?? "").replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, "");
  for (const para of noFences.split(/\n[ \t]*\n/)) {
    const squashed = para
      .replace(/\s+/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images drop away entirely …
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // … links flatten to their text
      .trim();
    if (!squashed || !/^[A-Za-z`"'(]/.test(squashed)) continue;
    const sentence = squashed.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? squashed;
    if (sentence.length <= max) return sentence;
    return `${sentence.slice(0, max).replace(/\s+\S*$/, "")}…`;
  }
  return "";
}

// The llms.txt index: title, one-line description, then every published page
// grouped by sidebar section, each with an absolute link and a description.
export function buildLlmsTxt({ title, description, siteRoot, pages }) {
  const out = [`# ${title}`, "", `> ${description}`];
  let section = null;
  for (const page of pages) {
    const label = sectionLabelOf(page.id);
    if (label !== section) {
      section = label;
      out.push("", `## ${label}`, "");
    }
    const desc = page.description ? `: ${page.description}` : "";
    out.push(`- [${page.title}](${urlFor(page.id, siteRoot)})${desc}`);
  }
  out.push(
    "",
    "## Optional",
    "",
    `- [llms-full.txt](${siteRoot}/llms-full.txt): every page above as one plain-markdown file`,
  );
  return `${out.join("\n")}\n`;
}

// The llms-full.txt concatenation: every page as plain markdown, in the same
// deterministic order, separated by thematic breaks.
export function buildLlmsFullTxt({ title, description, siteRoot, pages }) {
  const out = [
    `# ${title} — full documentation`,
    "",
    `> ${description}`,
    "",
    `Index of pages: ${siteRoot}/llms.txt · Site: ${urlFor("index", siteRoot)}`,
  ];
  for (const page of pages) {
    out.push("", "---", "", `# ${page.title}`, "", `URL: ${urlFor(page.id, siteRoot)}`, "", page.plain.trimEnd());
  }
  return `${out.join("\n")}\n`;
}
