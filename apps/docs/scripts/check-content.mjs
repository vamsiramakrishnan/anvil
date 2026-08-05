#!/usr/bin/env node
// Validate the generated Starlight content before Astro renders it. The sync
// step must run first so canonical docs/ and skills/ pages are present.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SITE_BASE } from "../src/lib/site-meta.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = resolve(HERE, "..", "src", "content", "docs");

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const pages = filesUnder(DOCS_ROOT).filter((path) => [".md", ".mdx"].includes(extname(path)));
const normalizedBase = SITE_BASE.replace(/^\//, "").replace(/\/$/, "");

function pageRoute(path) {
  let id = relative(DOCS_ROOT, path).split(sep).join("/").replace(/\.(?:md|mdx)$/, "");
  if (id === "index") id = "";
  return `/${normalizedBase}${id ? `/${id}` : ""}/`;
}

const routes = new Set(pages.map(pageRoute));
routes.add(`/${normalizedBase}/playground/`);
routes.add(`/${normalizedBase}/llms.txt`);
routes.add(`/${normalizedBase}/llms-full.txt`);

function frontmatter(raw) {
  if (!raw.startsWith("---\n")) return "";
  const end = raw.indexOf("\n---\n", 4);
  return end < 0 ? "" : raw.slice(4, end);
}

function targets(raw) {
  const found = [];
  for (const match of raw.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const parsed = /^(\S+)/.exec(match[1].trim());
    if (parsed) found.push(parsed[1]);
  }
  for (const match of raw.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)) found.push(match[1]);
  return found;
}

function withoutSuffix(target) {
  const cut = [target.indexOf("#"), target.indexOf("?")]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  return cut === undefined ? target : target.slice(0, cut);
}

const failures = [];
for (const path of pages) {
  const raw = readFileSync(path, "utf8");
  const fm = frontmatter(raw);
  const name = relative(DOCS_ROOT, path).split(sep).join("/");
  if (!fm) failures.push(`${name}: missing YAML frontmatter`);
  if (!/^title:\s*\S/m.test(fm)) failures.push(`${name}: missing frontmatter title`);
  if (!/^description:\s*\S/m.test(fm)) failures.push(`${name}: missing frontmatter description`);

  for (const target of targets(raw)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
    const clean = withoutSuffix(target);
    if (!clean) continue;

    if (clean.startsWith("/")) {
      const route = clean.endsWith("/") || /\.[a-z0-9]+$/i.test(clean) ? clean : `${clean}/`;
      if (!routes.has(route)) failures.push(`${name}: unresolved site route ${target}`);
      continue;
    }

    const local = resolve(dirname(path), clean);
    if (!existsSync(local)) failures.push(`${name}: unresolved relative link ${target}`);
  }
}

if (failures.length > 0) {
  console.error(`Documentation validation failed (${failures.length} issue${failures.length === 1 ? "" : "s"}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`validated ${pages.length} documentation pages and their local links`);
}
