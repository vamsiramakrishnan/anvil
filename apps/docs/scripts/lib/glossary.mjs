// Glossary term auto-linking for the docs/ → site sync.
//
// docs/GLOSSARY.md is the single source of vocabulary truth. At sync time we
// parse its headwords + anchors and, in every synced page's PROSE, link the
// first occurrence of each term to the glossary page — rendered as a plain
// HTML <a> whose title attribute carries the entry's first sentence, so
// hovering any linked term gives a zero-JS tooltip definition. (The sync emits
// .md, and Starlight passes raw HTML through, so the anchor survives.)
//
// Never links inside fenced code blocks, inline code, headings, existing
// markdown links/images, raw HTML tags, or aside markers.

// Same id the site's markdown renderer (github-slugger via Astro/Starlight)
// produces for a heading — lowercase, drop punctuation, spaces → hyphens.
export function headingSlug(heading) {
  return heading
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/ /g, "-");
}

// Strip markdown so the sentence is safe inside an HTML title attribute.
function cleanSentenceText(text) {
  return text
    .replace(/\*\*?|__|`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[<>{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(text) {
  const clean = cleanSentenceText(text);
  const m = clean.match(/^.*?[.!?]["')\]]*(?=\s|$)/);
  return (m ? m[0] : clean).trim();
}

// "Approval (operation state)" is one entry but pages just say "approval";
// "Evidence claim (a.k.a. claim)" is linkable under both spellings. Expand the
// headword into the aliases a page would actually use: strip a qualifying
// parenthetical, split "X / Y" alternates, keep an "(a.k.a. Y)" alias.
function aliasesFor(headword) {
  const aliases = [];
  const aka = headword.match(/^(.*?)\s*\(a\.k\.a\.\s+(.*?)\)\s*$/i);
  let base = aka ? aka[1] : headword;
  const qualified = base.match(/^(.*?)\s*\([^)]*\)\s*$/);
  if (qualified) base = qualified[1];
  for (const part of base.split(/\s+\/\s+/)) aliases.push(part.trim());
  if (aka) aliases.push(aka[2].trim());
  return aliases.filter(Boolean);
}

/**
 * Parse docs/GLOSSARY.md into linkable entries.
 *
 * The file's shape is one `## Headword` per term followed by a 1–3 sentence
 * definition paragraph. Returns [{ term, aliases, anchor, title }] where
 * `title` is the definition's first sentence (the hover tooltip text) and
 * `anchor` matches the heading id Starlight will render.
 */
export function parseGlossary(markdown) {
  const entries = [];
  const sections = [...markdown.matchAll(/^##\s+(.+?)\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/gm)];
  for (const [, heading, body] of sections) {
    const headword = heading.trim();
    const definition = body.trim();
    if (!definition) continue;
    entries.push({
      term: headword,
      aliases: aliasesFor(headword),
      anchor: headingSlug(headword),
      title: firstSentence(definition),
    });
  }
  return entries;
}

// Regions of the page the linker must never touch: fenced code blocks, inline
// code, headings, aside markers, existing markdown links/images, whole HTML
// anchors, and any other raw HTML tag (incl. autolinks like <https://…>).
const MASK_PATTERNS = [
  /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|(?![\s\S]))/gm, // fenced code
  /``[^`]*``|`[^`\n]*`/g, // inline code
  /^#{1,6}[ \t].*$/gm, // headings
  /^:{3,}.*$/gm, // aside open/close markers
  /!?\[[^\]]*\]\([^)]*\)/g, // markdown links + images (label and URL)
  /<a[\s>][\s\S]*?<\/a>/gi, // whole HTML anchors (already-linked text)
  /<[^<>\n]+>/g, // any other raw HTML tag incl. attributes
];

function buildMask(text) {
  const mask = new Uint8Array(text.length);
  for (const pattern of MASK_PATTERNS) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      mask.fill(1, m.index, m.index + m[0].length);
    }
  }
  return mask;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary pattern for one alias: hyphens count as boundaries only
// outward ("human-approval" must NOT match inside "human-approval tier"'s
// remainder or split identifiers), inner spaces tolerate a line wrap, and a
// trailing s/es keeps plurals linkable. All-caps acronyms (AIR) match
// case-sensitively so prose like "air.json" is never captured.
function aliasPattern(alias) {
  const acronym = /^[A-Z0-9]{2,}$/.test(alias);
  let core;
  if (acronym) core = escapeRegExp(alias);
  else if (/s$/i.test(alias)) core = `${escapeRegExp(alias.slice(0, -1))}s?`;
  else core = `${escapeRegExp(alias)}(?:e?s)?`;
  core = core.split(" ").join("(?:[ \\t]+|[ \\t]*\\n[ \\t]*)");
  return new RegExp(`(?<![\\w-])${core}(?![\\w-])`, acronym ? "g" : "gi");
}

function attrEscape(text) {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Link the first prose occurrence of each glossary term in `text` to
 * `${route}#${anchor}` as `<a href title>` (title = first sentence of the
 * entry → hover tooltip). Longest alias wins where terms overlap ("idempotency
 * ledger" beats "idempotency"); each entry links at most once, at its
 * earliest-occurring alias.
 */
export function linkGlossaryTerms(text, entries, { route }) {
  const mask = buildMask(text);
  const aliases = [];
  for (const entry of entries) {
    for (const alias of entry.aliases) aliases.push({ alias, entry });
  }
  aliases.sort((a, b) => b.alias.length - a.alias.length);

  const claimed = []; // [start, end) ranges already taken (longest-first)
  const overlaps = (s, e) => claimed.some(([cs, ce]) => s < ce && e > cs);
  const masked = (s, e) => {
    for (let i = s; i < e; i++) if (mask[i]) return true;
    return false;
  };

  const candidates = [];
  for (const { alias, entry } of aliases) {
    const re = aliasPattern(alias);
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (masked(start, end) || overlaps(start, end)) continue;
      claimed.push([start, end]);
      candidates.push({ start, end, entry, matched: m[0] });
      break; // first eligible occurrence of this alias only
    }
  }

  // One link per entry: keep its earliest-occurring alias.
  const byEntry = new Map();
  for (const c of candidates) {
    const prev = byEntry.get(c.entry);
    if (!prev || c.start < prev.start) byEntry.set(c.entry, c);
  }

  const chosen = [...byEntry.values()].sort((a, b) => b.start - a.start);
  let out = text;
  for (const { start, end, entry, matched } of chosen) {
    const href = `${route}#${entry.anchor}`;
    const link = `<a href="${href}" title="${attrEscape(entry.title)}">${matched}</a>`;
    out = out.slice(0, start) + link + out.slice(end);
  }
  return out;
}
