/**
 * A small, dependency-free XML parser — just enough to read WSDL 1.1 and its
 * embedded XSD. It produces a DOM-like tree of elements (tag, attributes,
 * children, text). Namespace prefixes are preserved verbatim on tags/attrs;
 * WSDL consumers match on the local name (see `localName`). It handles
 * elements, self-closing tags, attributes (single/double quoted), text nodes,
 * comments, CDATA, the XML declaration, and processing instructions.
 *
 * This is not a validating parser and does not resolve entities beyond the five
 * predefined ones; it is intentionally forgiving so a real-world WSDL parses
 * into a usable tree rather than throwing on a stray construct.
 */

export interface XmlElement {
  /** Tag as written, including any namespace prefix (e.g. "wsdl:message"). */
  tag: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Concatenated direct text content. */
  text: string;
}

/** Local name of a possibly-prefixed QName ("xs:string" → "string"). */
export function localName(qname: string): string {
  const idx = qname.indexOf(":");
  return idx >= 0 ? qname.slice(idx + 1) : qname;
}

/** Prefix of a QName ("tns:Foo" → "tns"), or "" when unprefixed. */
export function prefixOf(qname: string): string {
  const idx = qname.indexOf(":");
  return idx >= 0 ? qname.slice(0, idx) : "";
}

const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m) => {
    if (m.startsWith("&#x")) return String.fromCodePoint(Number.parseInt(m.slice(3, -1), 16));
    if (m.startsWith("&#")) return String.fromCodePoint(Number.parseInt(m.slice(2, -1), 10));
    return ENTITIES[m] ?? m;
  });
}

export function parseXml(src: string): XmlElement {
  let i = 0;
  const n = src.length;
  const root: XmlElement = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];

  const top = (): XmlElement => stack[stack.length - 1] as XmlElement;

  while (i < n) {
    if (src[i] !== "<") {
      // Text node.
      let text = "";
      while (i < n && src[i] !== "<") {
        text += src[i];
        i++;
      }
      const trimmed = decodeEntities(text).trim();
      if (trimmed) top().text += (top().text ? " " : "") + trimmed;
      continue;
    }
    // A tag of some kind.
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i);
      const content = src.slice(i + 9, end < 0 ? n : end);
      top().text += (top().text ? " " : "") + content.trim();
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (src.startsWith("<!", i)) {
      // DOCTYPE or similar — skip to the matching '>'.
      const end = src.indexOf(">", i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    // Closing tag.
    if (src.startsWith("</", i)) {
      const end = src.indexOf(">", i);
      i = end < 0 ? n : end + 1;
      if (stack.length > 1) stack.pop();
      continue;
    }
    // Opening (or self-closing) tag.
    const end = findTagEnd(src, i);
    const inner = src.slice(i + 1, end).trim();
    i = end + 1;
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1).trim() : inner;
    const { tag, attrs } = parseTag(body);
    const element: XmlElement = { tag, attrs, children: [], text: "" };
    top().children.push(element);
    if (!selfClosing) stack.push(element);
  }

  // The document element is the first real child of the synthetic root.
  return (root.children[0] as XmlElement | undefined) ?? root;
}

/** Find the index of the '>' that closes a tag, respecting quoted attributes. */
function findTagEnd(src: string, start: number): number {
  let i = start + 1;
  const n = src.length;
  let quote: string | null = null;
  while (i < n) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
    i++;
  }
  return n;
}

function parseTag(body: string): { tag: string; attrs: Record<string, string> } {
  let i = 0;
  const n = body.length;
  const readName = (): string => {
    let name = "";
    while (i < n && !/[\s=/>]/.test(body[i] as string)) {
      name += body[i];
      i++;
    }
    return name;
  };
  const skipWs = () => {
    while (i < n && /\s/.test(body[i] as string)) i++;
  };
  const tag = readName();
  const attrs: Record<string, string> = {};
  skipWs();
  while (i < n) {
    skipWs();
    if (i >= n) break;
    const attrName = readName();
    if (!attrName) {
      i++;
      continue;
    }
    skipWs();
    if (body[i] === "=") {
      i++;
      skipWs();
      const quote = body[i];
      if (quote === '"' || quote === "'") {
        i++;
        let val = "";
        while (i < n && body[i] !== quote) {
          val += body[i];
          i++;
        }
        i++;
        attrs[attrName] = decodeEntities(val);
      } else {
        // Unquoted value.
        let val = "";
        while (i < n && !/[\s>]/.test(body[i] as string)) {
          val += body[i];
          i++;
        }
        attrs[attrName] = decodeEntities(val);
      }
    } else {
      attrs[attrName] = "";
    }
  }
  return { tag, attrs };
}

/** All descendant elements (depth-first) whose local name matches. */
export function findAll(el: XmlElement, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (node: XmlElement) => {
    for (const child of node.children) {
      if (localName(child.tag) === local) out.push(child);
      walk(child);
    }
  };
  walk(el);
  return out;
}

/** Direct children whose local name matches. */
export function childrenNamed(el: XmlElement, local: string): XmlElement[] {
  return el.children.filter((c) => localName(c.tag) === local);
}

/** First descendant with the given local name, or undefined. */
export function firstNamed(el: XmlElement, local: string): XmlElement | undefined {
  return findAll(el, local)[0];
}
