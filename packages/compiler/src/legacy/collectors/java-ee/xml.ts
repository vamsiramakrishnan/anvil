import { XMLValidator } from "fast-xml-parser";
import {
  childrenNamed,
  findAll,
  localName,
  parseXml,
  type XmlElement,
} from "../../../protocols/xml.js";

export interface SafeXmlSuccess {
  ok: true;
  root: XmlElement;
}

export interface SafeXmlFailure {
  ok: false;
  kind: "unsafe" | "malformed";
  message: string;
}

/**
 * Parse deployment XML as inert data. DTDs and entity declarations are refused
 * before invoking the parser; Java EE descriptors do not need either construct
 * for inventory and accepting them would create an unnecessary XXE surface.
 */
export function parseSafeDescriptorXml(source: string): SafeXmlSuccess | SafeXmlFailure {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(source)) {
    return {
      ok: false,
      kind: "unsafe",
      message: "DTD and entity declarations are not accepted in legacy inventory XML.",
    };
  }

  const validation = XMLValidator.validate(source, {
    allowBooleanAttributes: false,
    unpairedTags: [],
  });
  if (validation !== true) {
    return {
      ok: false,
      kind: "malformed",
      message: validation.err.msg,
    };
  }

  try {
    const root = parseXml(source);
    if (root.tag === "#root") {
      return { ok: false, kind: "malformed", message: "XML document has no root element." };
    }
    return { ok: true, root };
  } catch (error) {
    return { ok: false, kind: "malformed", message: String(error) };
  }
}

export function child(element: XmlElement, name: string): XmlElement | undefined {
  return childrenNamed(element, name)[0];
}

export function childText(element: XmlElement, name: string): string | undefined {
  const value = child(element, name)?.text.trim();
  return value ? value : undefined;
}

export function attr(element: XmlElement, name: string): string | undefined {
  for (const [key, value] of Object.entries(element.attrs)) {
    if (localName(key) === name && value.trim()) return value.trim();
  }
  return undefined;
}

export function descendants(element: XmlElement, name: string): XmlElement[] {
  return findAll(element, name);
}

export function elementName(element: XmlElement): string {
  return localName(element.tag);
}

export function values(elements: readonly XmlElement[]): string[] {
  return [...new Set(elements.map((element) => element.text.trim()).filter(Boolean))].sort();
}
