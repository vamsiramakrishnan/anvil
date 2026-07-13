// GET /anvil/llms-full.txt — the whole documentation set as one plain-markdown
// file for LLM consumption: every published page (same collection Starlight
// renders, same deterministic order as /anvil/llms.txt), frontmatter dropped,
// MDX imports/components stripped back out (src/lib/llms.mjs). Static
// endpoint: built into dist/llms-full.txt by `astro build`.
import { getCollection } from "astro:content";
import {
  buildLlmsFullTxt,
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
    plain: plainifyMdx(entry.body, { base: SITE_BASE, siteRoot }),
  }));
  return new Response(buildLlmsFullTxt({ title: SITE_TITLE, description: SITE_DESCRIPTION, siteRoot, pages }), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
