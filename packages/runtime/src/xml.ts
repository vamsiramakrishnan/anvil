/**
 * A deliberately small XML reader and writer for SOAP envelopes.
 *
 * Node has no XML parser in its standard library, and the deployed unit is
 * meant to stay small, so this is hand-written rather than a dependency. The
 * same algorithm is emitted into the generated TypeScript SDK, which is
 * zero-dependency by contract.
 *
 * It is *restricted*, and that is the security posture rather than a
 * limitation. It refuses `<!DOCTYPE` outright and never expands an entity
 * beyond the five XML predefined ones plus numeric character references. The
 * two classic XML attacks — external entity expansion (XXE) reading local files
 * or making outbound requests, and recursive entity expansion (the billion
 * laughs denial of service) — both require a DTD, and there is no code path
 * here that parses one. They are impossible rather than defended against, which
 * is a stronger property and much less code.
 *
 * It handles the subset a SOAP response actually uses: elements, attributes,
 * text, CDATA, comments, processing instructions, self-closing tags, and
 * namespace prefixes preserved verbatim on the tag. It is not a general XML
 * parser and should never be used as one.
 */

export interface XmlNode {
  /** Tag as written, prefix included (e.g. `soap:Body`). */
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated direct text content, entity-decoded. */
  text: string;
}

export class XmlError extends Error {}

/** Local name of a possibly-prefixed QName. */
export function localName(qname: string): string {
  const idx = qname.indexOf(":");
  return idx >= 0 ? qname.slice(idx + 1) : qname;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Decode the five predefined entities and numeric character references. An
 *  unknown entity is left verbatim rather than resolved: resolving one would
 *  mean consulting a DTD, which is exactly what this reader refuses to do. */
function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body.startsWith("#x")
        ? Number.parseInt(body.slice(2), 16)
        : Number(body.slice(1));
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** Escape text for an element body or an attribute value. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[-A-Za-z0-9_.:]/;

/**
 * Parse an XML document into a node tree.
 *
 * Throws `XmlError` on anything malformed or refused. A parse failure is a
 * refusal, never a partial tree: half-read XML is how a fault gets mistaken for
 * a result.
 */
export function parseXml(source: string, maxDepth = 64): XmlNode {
  let i = 0;
  const n = source.length;

  const fail = (why: string): never => {
    throw new XmlError(`${why} at offset ${i}`);
  };

  const readName = (): string => {
    const start = i;
    if (i >= n || !NAME_START.test(source[i] as string)) fail("expected a tag name");
    i += 1;
    while (i < n && NAME_CHAR.test(source[i] as string)) i += 1;
    return source.slice(start, i);
  };

  const skipSpace = (): void => {
    while (i < n && /\s/.test(source[i] as string)) i += 1;
  };

  const readAttrs = (): Record<string, string> => {
    const attrs: Record<string, string> = {};
    for (;;) {
      skipSpace();
      if (i >= n) fail("unterminated tag");
      const c = source[i] as string;
      if (c === ">" || c === "/") return attrs;
      const name = readName();
      skipSpace();
      if (source[i] !== "=") fail(`attribute '${name}' has no value`);
      i += 1;
      skipSpace();
      const quote = source[i];
      if (quote !== '"' && quote !== "'") {
        return fail(`attribute '${name}' is not quoted`);
      }
      i += 1;
      const end = source.indexOf(quote, i);
      if (end < 0) fail(`attribute '${name}' is unterminated`);
      attrs[name] = decodeEntities(source.slice(i, end));
      i = end + 1;
    }
  };

  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;

  while (i < n) {
    const lt = source.indexOf("<", i);
    if (lt < 0) break;

    if (lt > i) {
      const chunk = source.slice(i, lt);
      const current = stack[stack.length - 1];
      if (current && chunk.trim()) current.text += decodeEntities(chunk);
    }
    i = lt;

    // A DTD is the prerequisite for both XXE and entity-expansion attacks, so
    // it is refused rather than skipped — skipping it would leave entity
    // references in the document resolving to nothing, silently.
    if (source.startsWith("<!DOCTYPE", i) || source.startsWith("<!ENTITY", i)) {
      fail("a DOCTYPE or ENTITY declaration is refused; this reader resolves no external entities");
    }

    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      if (end < 0) fail("unterminated comment");
      i = end + 3;
      continue;
    }

    if (source.startsWith("<![CDATA[", i)) {
      const end = source.indexOf("]]>", i + 9);
      if (end < 0) fail("unterminated CDATA section");
      const current = stack[stack.length - 1];
      if (current) current.text += source.slice(i + 9, end);
      i = end + 3;
      continue;
    }

    if (source.startsWith("<?", i)) {
      const end = source.indexOf("?>", i + 2);
      if (end < 0) fail("unterminated processing instruction");
      i = end + 2;
      continue;
    }

    if (source.startsWith("</", i)) {
      i += 2;
      const name = readName();
      skipSpace();
      if (source[i] !== ">") fail("unterminated closing tag");
      i += 1;
      const open = stack.pop();
      if (!open) fail(`closing tag '${name}' has no open element`);
      if (open && open.tag !== name) fail(`closing tag '${name}' does not match '${open.tag}'`);
      continue;
    }

    i += 1;
    const tag = readName();
    const attrs = readAttrs();
    const selfClosing = source[i] === "/";
    if (selfClosing) i += 1;
    if (source[i] !== ">") fail(`unterminated tag '${tag}'`);
    i += 1;

    const node: XmlNode = { tag, attrs, children: [], text: "" };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else if (root) fail("a document may have only one root element");
    else root = node;

    if (!selfClosing) {
      // Depth is bounded so a pathologically nested document cannot exhaust the
      // stack. Without a DTD there is no expansion attack, but a hostile server
      // can still send deeply nested elements directly.
      if (stack.length >= maxDepth) fail(`element nesting exceeds ${maxDepth}`);
      stack.push(node);
    }
  }

  if (stack.length > 0) throw new XmlError(`unclosed element '${stack[stack.length - 1]?.tag}'`);
  if (!root) throw new XmlError("no root element");
  return root;
}

/** Direct children whose local name matches, prefix ignored. */
export function childrenNamed(node: XmlNode, local: string): XmlNode[] {
  return node.children.filter((child) => localName(child.tag) === local);
}

/** The first descendant whose local name matches, breadth-first. */
export function findFirst(node: XmlNode, local: string): XmlNode | undefined {
  const queue: XmlNode[] = [node];
  while (queue.length > 0) {
    const current = queue.shift() as XmlNode;
    if (current !== node && localName(current.tag) === local) return current;
    queue.push(...current.children);
  }
  return undefined;
}

/**
 * Turn an element tree into plain JSON-ish data.
 *
 * Repeated sibling names become an array — the only shape that survives a
 * server returning one item where the contract implies many, which is the
 * commonest way an XML-to-JSON mapping goes wrong. A leaf element becomes its
 * text; an element with attributes and children keeps the attributes under
 * their written names.
 */
export function xmlToValue(node: XmlNode): unknown {
  const hasChildren = node.children.length > 0;
  const attrKeys = Object.keys(node.attrs).filter((k) => k !== "xmlns" && !k.startsWith("xmlns:"));
  if (!hasChildren && attrKeys.length === 0) return node.text;

  const out: Record<string, unknown> = {};
  for (const key of attrKeys) out[key] = node.attrs[key];
  for (const child of node.children) {
    const key = localName(child.tag);
    const value = xmlToValue(child);
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  if (!hasChildren && node.text) out["#text"] = node.text;
  return out;
}

/** Serialize a value as the children of an element. Objects become elements,
 *  arrays repeat their element, and nothing is emitted for null/undefined —
 *  an absent optional field is absent, not an empty tag. */
export function valueToXml(value: unknown, name: string, prefix: string): string {
  const tag = prefix ? `${prefix}:${name}` : name;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((item) => valueToXml(item, name, prefix)).join("");
  if (typeof value === "object") {
    const inner = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => valueToXml(item, key, prefix))
      .join("");
    return `<${tag}>${inner}</${tag}>`;
  }
  return `<${tag}>${escapeXml(String(value))}</${tag}>`;
}
