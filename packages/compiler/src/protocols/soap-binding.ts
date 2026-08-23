import type { WireBinding } from "@anvil/air";
import { childrenNamed, findAll, localName, type XmlElement } from "./xml.js";

/**
 * What a real SOAP call needs, read out of `wsdl:binding`.
 *
 * The WSDL adapter lowers a service into a REST-shaped document because the
 * rest of the pipeline is path-keyed, and in doing so it discards every fact
 * that makes a SOAP call a SOAP call: the endpoint, the action header, the
 * envelope, and the namespaces the body element is qualified by. Those facts
 * are all present in the document and were simply never read.
 *
 * This module reads them. It lives beside the adapter rather than inside it
 * because binding-and-envelope is its own concern with its own vocabulary, and
 * because `wsdl.ts` already owns enough.
 *
 * A deliberate limit: only `document`/`literal` is claimed. `rpc` wraps the
 * parts in an operation-named element and `encoded` carries per-element type
 * attributes; both are expressible and neither is implemented, so this returns
 * a refusal rather than a binding and the transport gate keeps refusing the
 * operation. Claiming support Anvil does not have is the failure mode the whole
 * transport model exists to end.
 */

/** WSDL binding namespaces, which are what actually identify the SOAP version. */
const SOAP_11_WSDL = "http://schemas.xmlsoap.org/wsdl/soap/";
const SOAP_12_WSDL = "http://schemas.xmlsoap.org/wsdl/soap12/";

const ENVELOPE_NS = {
  "1.1": "http://schemas.xmlsoap.org/soap/envelope/",
  "1.2": "http://www.w3.org/2003/05/soap-envelope",
} as const;

const CONTENT_TYPE = {
  "1.1": "text/xml; charset=utf-8",
  "1.2": "application/soap+xml; charset=utf-8",
} as const;

type SoapVersion = "1.1" | "1.2";

export interface SoapOperationBinding {
  soapAction?: string;
  style: string;
  use: string;
  version: SoapVersion;
}

/** `prefix -> namespace URI` declared on this element, plus the default one
 *  under the empty-string key. Attributes are preserved verbatim by `xml.ts`,
 *  so the declarations are simply sitting in `attrs`. */
export function namespacesOf(el: XmlElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(el.attrs)) {
    if (key === "xmlns") out[""] = value;
    else if (key.startsWith("xmlns:")) out[key.slice(6)] = value;
  }
  return out;
}

/**
 * Resolve a QName written in the document — `tns:TransferFundsRequest` — into
 * the namespace and local name an envelope must qualify its body element with.
 *
 * This is the one place the adapter is namespace-*aware*, and it does not
 * disturb the namespace-blind XSD merge: that merge resolves type definitions
 * by local name across imported schemas, which is a different question from
 * what a body element is called on the wire.
 */
function resolveQName(
  qname: string,
  namespaces: Record<string, string>,
  fallbackNamespace: string,
): { namespace: string; local: string } {
  const idx = qname.indexOf(":");
  if (idx < 0) return { namespace: namespaces[""] ?? fallbackNamespace, local: qname };
  const prefix = qname.slice(0, idx);
  return {
    namespace: namespaces[prefix] ?? fallbackNamespace,
    local: qname.slice(idx + 1),
  };
}

function soapVersionOf(binding: XmlElement, namespaces: Record<string, string>): SoapVersion {
  // The version is carried by which namespace the `soap:` prefix on the
  // extension element resolves to, not by any version attribute.
  for (const child of binding.children) {
    if (localName(child.tag) !== "binding") continue;
    const idx = child.tag.indexOf(":");
    if (idx < 0) continue;
    const uri = namespaces[child.tag.slice(0, idx)];
    if (uri === SOAP_12_WSDL) return "1.2";
    if (uri === SOAP_11_WSDL) return "1.1";
  }
  return "1.1";
}

/**
 * Every SOAP operation binding in the document, keyed by operation name.
 *
 * Keyed by name alone: a WSDL may bind one portType more than once (SOAP 1.1
 * and 1.2 side by side is the common case), and Anvil exposes one operation per
 * name. First binding wins, which makes 1.1 the default where both exist —
 * deliberate, since 1.1 is what the legacy estate actually serves.
 */
export function collectSoapBindings(
  definitions: readonly XmlElement[],
): Map<string, SoapOperationBinding> {
  const found = new Map<string, SoapOperationBinding>();
  for (const doc of definitions) {
    const namespaces = namespacesOf(doc);
    for (const binding of findAll(doc, "binding")) {
      // `findAll` reaches nested elements too; a `soap:binding` extension has no
      // `type`, which is how a real `wsdl:binding` is told apart from it.
      if (!binding.attrs.type) continue;
      const version = soapVersionOf(binding, namespaces);
      const style =
        childrenNamed(binding, "binding")
          .map((b) => b.attrs.style)
          .find((s) => s !== undefined) ?? "document";

      for (const operation of childrenNamed(binding, "operation")) {
        const name = operation.attrs.name;
        if (!name || found.has(name)) continue;
        const soapOperation = childrenNamed(operation, "operation")[0];
        const input = childrenNamed(operation, "input")[0];
        const use = (input ? childrenNamed(input, "body")[0]?.attrs.use : undefined) ?? "literal";
        found.set(name, {
          soapAction: soapOperation?.attrs.soapAction || undefined,
          style: soapOperation?.attrs.style ?? style,
          use,
          version,
        });
      }
    }
  }
  return found;
}

export type BindingOutcome = { ok: true; binding: WireBinding } | { ok: false; reason: string };

/**
 * Assemble the wire binding for one operation, or say why it cannot be built.
 *
 * `requestElement` is the `wsdl:part/@element` QName the adapter already reads
 * and then discards the prefix of. Its absence means the message is described
 * by `type` rather than `element` — the rpc-style shape — which this declines
 * for the same reason as `use="encoded"`.
 */
export function soapWireBinding(input: {
  operation: SoapOperationBinding | undefined;
  requestElement: string | undefined;
  responseElement: string | undefined;
  namespaces: Record<string, string>;
  targetNamespace: string;
}): BindingOutcome {
  const { operation, requestElement, responseElement, namespaces, targetNamespace } = input;
  if (!operation) {
    return { ok: false, reason: "no soap:binding declares this operation" };
  }
  if (operation.style !== "document") {
    return {
      ok: false,
      reason: `soap:binding style is "${operation.style}"; Anvil encodes document/literal only`,
    };
  }
  if (operation.use !== "literal") {
    return {
      ok: false,
      reason: `soap:body use is "${operation.use}"; Anvil encodes document/literal only`,
    };
  }
  if (!requestElement) {
    return {
      ok: false,
      reason:
        "the input message declares no element; Anvil encodes element-described messages only",
    };
  }
  const body = resolveQName(requestElement, namespaces, targetNamespace);
  const response = responseElement
    ? resolveQName(responseElement, namespaces, targetNamespace)
    : undefined;
  return {
    ok: true,
    binding: {
      ...(operation.soapAction ? { soapAction: operation.soapAction } : {}),
      envelopeNamespace: ENVELOPE_NS[operation.version],
      bodyNamespace: body.namespace,
      bodyElement: body.local,
      ...(response ? { responseElement: response.local } : {}),
      contentType: CONTENT_TYPE[operation.version],
      soapVersion: operation.version,
    },
  };
}
