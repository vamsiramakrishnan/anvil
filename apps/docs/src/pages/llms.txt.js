// GET /anvil/llms.txt — the https://llmstxt.org/ index of this docs site:
// title, one-line description, then every published page (the same content
// collection Starlight renders — curated pages plus the docs/ + skills/ sync)
// with an absolute URL and a description, in deterministic sidebar-then-slug
// order. Static endpoint: built into dist/llms.txt by `astro build`.
import { getCollection } from "astro:content";
import {
  buildLlmsTxt,
  firstProseSentence,
  isPublished,
  orderPages,
  plainifyMdx,
  siteRootFrom,
} from "../lib/llms.mjs";
import { SITE_BASE, SITE_DESCRIPTION, SITE_TITLE, SITE_URL } from "../lib/site-meta.mjs";

export async function GET() {
  const entries = (await getCollection("docs")).filter(isPublished);
  const siteRoot = siteRootFrom(SITE_URL, SITE_BASE);
  const pages = orderPages(entries).map((entry) => ({
    id: entry.id,
    title: entry.data.title ?? entry.id,
    description: entry.data.description || firstProseSentence(plainifyMdx(entry.body)),
  }));
  return new Response(buildLlmsTxt({ title: SITE_TITLE, description: SITE_DESCRIPTION, siteRoot, pages }), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
