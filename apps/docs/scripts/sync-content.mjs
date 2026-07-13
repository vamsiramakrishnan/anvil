#!/usr/bin/env node
// Build-time content sync: the repo's canonical markdown (docs/, skills/) → this
// site's Starlight content tree. The website is a *view* of those files, never a
// second copy to maintain — this runs before every `astro dev`/`astro build`
// (see package.json), and everything it writes is gitignored. Edit the source
// markdown, not the generated pages.
//
// Anvil's docs are plain CommonMark, so the transform is deliberately small:
//   1. drop any existing YAML frontmatter (keep its `description` if present)
//   2. drop the leading H1 (Starlight renders the title from frontmatter)
//   3. synthesize Starlight frontmatter: title, description, sidebar order,
//      and an editUrl pointing back at the source file on GitHub
//   4. emit `.md` (NOT `.mdx`) so raw prose tokens (`<`, `{`) never need escaping
//
//   node apps/docs/scripts/sync-content.mjs [--dry-run]
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_URL } from "../src/lib/site-meta.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const CONTENT = join(HERE, "..", "src", "content", "docs");
const DRY_RUN = process.argv.includes("--dry-run");

// Sections this script owns (gitignored). Curated pages (index.mdx, start/) are
// checked in and never touched here.
const SYNCED_SECTIONS = ["concepts", "guides", "design", "reference"];

/** Curated source → destination map. Order drives the sidebar. */
const PAGES = [
  { src: "docs/ARCHITECTURE.md", dest: "concepts/architecture.md", order: 1 },
  { src: "docs/PRODUCT_BOUNDARY.md", dest: "concepts/product-boundary.md", order: 2 },
  { src: "docs/mechanisms.md", dest: "concepts/mechanisms.md", order: 3 },
  {
    src: "skills/anvil/SKILL.md",
    dest: "guides/operating-anvil.md",
    order: 1,
    title: "Operating Anvil",
  },
  { src: "skills/anvil/reference/commands.md", dest: "guides/commands.md", order: 2 },
  { src: "skills/anvil/reference/workflow.md", dest: "guides/enrich-approve-workflow.md", order: 3 },
  { src: "docs/design/hooks-and-plugins.md", dest: "design/hooks-and-plugins.md", order: 1 },
  {
    src: "docs/INVESTIGATION_ARCHITECTURE.md",
    dest: "design/investigation-architecture.md",
    order: 2,
  },
];

/** Split off a leading `--- … ---` YAML block; return { body, fm } (fm is raw text). */
function splitFrontmatter(raw) {
  if (!raw.startsWith("---\n")) return { body: raw, fm: "" };
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return { body: raw, fm: "" };
  return { fm: raw.slice(4, end), body: raw.slice(end + 5) };
}

/** Grab a scalar value from crude `key: value` frontmatter text. */
function fmValue(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

/** First `# ` heading → title; return { title, body } with that line removed. */
function extractTitle(body) {
  const lines = body.split("\n");
  const i = lines.findIndex((l) => /^#\s+/.test(l));
  if (i === -1) return { title: "", body };
  const title = lines[i].replace(/^#\s+/, "").trim();
  lines.splice(i, 1);
  return { title, body: lines.join("\n").replace(/^\n+/, "") };
}

/** First real paragraph, flattened to one line, for a fallback description. */
function firstParagraph(body) {
  for (const block of body.split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t || t.startsWith("#") || t.startsWith("```") || t.startsWith("|") || t.startsWith(">"))
      continue;
    return t.replace(/\s+/g, " ").replace(/[[\]`*_]/g, "");
  }
  return "";
}

/** YAML-safe single-line double-quoted scalar, length-capped. */
function yamlString(s) {
  const clean = s.replace(/\s+/g, " ").trim().slice(0, 180);
  return `"${clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function transform({ src, dest, order, title }) {
  const abs = join(REPO_ROOT, src);
  const raw = readFileSync(abs, "utf8");
  const { fm, body: afterFm } = splitFrontmatter(raw);
  const { title: h1, body } = extractTitle(afterFm);
  const finalTitle = title || h1 || dest;
  const description = fmValue(fm, "description") || firstParagraph(body);

  const frontmatter = [
    "---",
    `title: ${yamlString(finalTitle)}`,
    description ? `description: ${yamlString(description)}` : "",
    "sidebar:",
    `  order: ${order}`,
    `editUrl: ${REPO_URL}/edit/main/${src}`,
    "---",
    "",
  ]
    .filter(Boolean)
    .join("\n");

  return `${frontmatter}\n${body.trimEnd()}\n`;
}

/** Every docs/adr/*.md → reference/adr/, ordered by the NNNN filename prefix. */
function adrPages() {
  const dir = join(REPO_ROOT, "docs", "adr");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f, i) => ({ src: `docs/adr/${f}`, dest: `reference/adr/${f}`, order: i + 1 }));
}

function run() {
  const pages = [...PAGES, ...adrPages()];
  if (!DRY_RUN) {
    for (const section of SYNCED_SECTIONS) {
      rmSync(join(CONTENT, section), { recursive: true, force: true });
    }
  }
  for (const page of pages) {
    const out = transform(page);
    const outPath = join(CONTENT, page.dest);
    if (DRY_RUN) {
      console.log(`would write ${page.dest} (${out.length} bytes) from ${page.src}`);
      continue;
    }
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, out, "utf8");
  }
  console.log(`${DRY_RUN ? "[dry-run] " : ""}synced ${pages.length} pages from docs/ + skills/`);
}

run();
