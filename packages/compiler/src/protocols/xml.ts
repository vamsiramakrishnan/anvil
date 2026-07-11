/**
 * A thin DOM-like view over `fast-xml-parser`, just enough to read WSDL 1.1 and
 * its embedded XSD. The library owns tokenizing/entity-decoding/CDATA/comments;
 * this module only reshapes its `preserveOrder` output into the small
 * `XmlElement` tree the WSDL adapter walks (tag, attributes, children, text).
 * Namespace prefixes are preserved verbatim on tags/attrs; consumers match on
 * the local name (see `localName`).
 */
import { XMLParser } from "fast-xml-parser";

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

const ATTRS_KEY = ":@";
const TEXT_KEY = "#text";

/** One node in fast-xml-parser's preserveOrder output. */
type OrderedNode = Record<string, unknown> & { [ATTRS_KEY]?: Record<string, unknown> };

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  // Keep every value as its authored string — WSDL/XSD reads attributes like
  // minOccurs="0" and maxOccurs="unbounded" that must not be coerced to numbers.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  commentPropName: undefined,
});

export function parseXml(src: string): XmlElement {
  const nodes = parser.parse(src) as OrderedNode[];
  const documentNode = nodes.find((node) => elementKey(node) !== undefined);
  if (!documentNode) return { tag: "#root", attrs: {}, children: [], text: "" };
  const tag = elementKey(documentNode) as string;
  return toElement(tag, documentNode, documentNode[ATTRS_KEY]);
}

/** The single element tag key of a node, ignoring attributes/text markers. */
function elementKey(node: OrderedNode): string | undefined {
  return Object.keys(node).find((k) => k !== ATTRS_KEY && k !== TEXT_KEY);
}

function toElement(tag: string, node: OrderedNode, rawAttrs: unknown): XmlElement {
  const attrs: Record<string, string> = {};
  if (rawAttrs && typeof rawAttrs === "object") {
    for (const [k, v] of Object.entries(rawAttrs)) attrs[k] = String(v);
  }
  const children: XmlElement[] = [];
  let text = "";
  const body = node[tag];
  const items = Array.isArray(body) ? (body as OrderedNode[]) : [];
  for (const item of items) {
    if (TEXT_KEY in item) {
      const chunk = String(item[TEXT_KEY]).trim();
      if (chunk) text += (text ? " " : "") + chunk;
      continue;
    }
    const childTag = elementKey(item);
    if (childTag === undefined) continue;
    children.push(toElement(childTag, item, item[ATTRS_KEY]));
  }
  return { tag, attrs, children, text };
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
