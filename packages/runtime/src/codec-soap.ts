import type { Operation, SoapWireBinding } from "@anvil/air";
import type { FaultAwareCodec, WireFault, WireParts } from "./codec.js";
import type { HttpRequest, HttpResponse } from "./transport.js";
import {
  childrenNamed,
  escapeXml,
  findFirst,
  localName,
  parseXml,
  valueToXml,
  XmlError,
  xmlToValue,
} from "./xml.js";

/**
 * SOAP 1.1 and 1.2, document/literal.
 *
 * The envelope is built by string rather than through a DOM: every value that
 * reaches it is escaped at the point it is written, which is easier to audit
 * than a tree walked by a serializer, and it needs no dependency in the
 * deployed unit.
 *
 * Everything this needs was read out of the WSDL by the compiler and lives in
 * `op.sourceRef.binding`. Nothing here infers a namespace, an action, or an
 * element name — if the binding is absent the operation never reaches this
 * codec, because the transport gate refused it first.
 */

const BODY_PREFIX = "n";
const ENV_PREFIX = "soap";

function bindingOf(op: Operation): SoapWireBinding {
  const binding = op.sourceRef.binding;
  if (binding?.protocol !== "soap") {
    // Unreachable through the executor — `wireExecutability` refuses an
    // operation with no binding before a request is built. Stated as an error
    // rather than a fallback because a SOAP call assembled from guesses is
    // exactly what this whole seam exists to prevent.
    throw new Error(`operation '${op.id}' reached the SOAP codec with no wire binding`);
  }
  return binding;
}

/**
 * The SOAP envelope for one call.
 *
 * The body element is namespace-qualified against the WSDL's target namespace —
 * an unqualified element is the single commonest reason a real server rejects
 * an otherwise correct request.
 */
function buildEnvelope(op: Operation, body: unknown): string {
  const binding = bindingOf(op);
  const fields =
    body === null || body === undefined || typeof body !== "object"
      ? ""
      : Object.entries(body as Record<string, unknown>)
          .map(([key, value]) => valueToXml(value, key, BODY_PREFIX))
          .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<${ENV_PREFIX}:Envelope xmlns:${ENV_PREFIX}="${escapeXml(binding.envelopeNamespace)}">` +
    `<${ENV_PREFIX}:Body>` +
    `<${BODY_PREFIX}:${binding.bodyElement} xmlns:${BODY_PREFIX}="${escapeXml(binding.bodyNamespace)}">` +
    fields +
    `</${BODY_PREFIX}:${binding.bodyElement}>` +
    `</${ENV_PREFIX}:Body>` +
    `</${ENV_PREFIX}:Envelope>`
  );
}

/**
 * Where the action goes. SOAP 1.1 sends it as its own `SOAPAction` header,
 * quoted; 1.2 has no such header and carries it as an `action` parameter of the
 * content type instead. Getting this wrong is not cosmetic — a 1.1 server
 * dispatches on it and answers a missing one with a fault.
 */
function actionHeaders(binding: SoapWireBinding): Record<string, string> {
  if (!binding.soapAction) return { "content-type": binding.contentType };
  if (binding.soapVersion === "1.2") {
    return { "content-type": `${binding.contentType}; action="${binding.soapAction}"` };
  }
  return {
    "content-type": binding.contentType,
    soapaction: `"${binding.soapAction}"`,
  };
}

/** The endpoint a SOAP service actually serves. The path in `sourceRef` is a
 *  coordinate Anvil synthesized to hold operations apart in a path-keyed model;
 *  the real address is the base URL, which is what `soap:address` supplied. */
function endpointFor(parts: WireParts): string {
  return parts.baseUrl.replace(/\/$/, "") || "/";
}

export const soapCodec: FaultAwareCodec = {
  protocol: "soap",

  encode(op: Operation, parts: WireParts): HttpRequest {
    const binding = bindingOf(op);
    const headers: Record<string, string> = {
      ...parts.headers,
      ...actionHeaders(binding),
      accept: binding.contentType.split(";")[0] ?? "text/xml",
    };
    return {
      method: "POST",
      url: endpointFor(parts),
      headers,
      body: buildEnvelope(op, parts.body),
    };
  },

  decode(op: Operation, res: HttpResponse): unknown {
    if (!res.body) return null;
    const root = parseXml(res.body);
    const bodyEl = findFirst(root, "Body");
    if (!bodyEl) throw new XmlError("the response has no soap:Body");
    const binding = op.sourceRef.binding?.protocol === "soap" ? op.sourceRef.binding : undefined;
    // Prefer the element the WSDL named; otherwise the body's single child,
    // which is what document/literal guarantees. Never merge several children:
    // a body carrying more than one element is not a shape this codec claims.
    const named = binding?.responseElement
      ? childrenNamed(bodyEl, binding.responseElement)[0]
      : undefined;
    const payload = named ?? bodyEl.children[0];
    if (!payload) return null;
    return xmlToValue(payload);
  },

  /**
   * A `soap:Fault` is a failure the transport delivered successfully. Some
   * servers return it with HTTP 500, some with 200 — the HTTP status is not
   * the answer, the envelope is. Reporting it as a result would let a failed
   * mutation be recorded in the idempotency ledger as a completed one.
   */
  faultIn(_op: Operation, res: HttpResponse): WireFault | undefined {
    if (!res.body || !res.body.includes("Fault")) return undefined;
    let root: ReturnType<typeof parseXml>;
    try {
      root = parseXml(res.body);
    } catch {
      return undefined;
    }
    const fault = findFirst(root, "Fault");
    if (!fault) return undefined;

    // 1.1 spells them faultcode/faultstring; 1.2 uses Code/Value and
    // Reason/Text. Read both rather than branching on the declared version:
    // a server that answers a 1.1 request with a 1.2 fault is not worth
    // losing the diagnosis over.
    const code =
      childrenNamed(fault, "faultcode")[0]?.text || findFirst(fault, "Value")?.text || "soap_fault";
    const message =
      childrenNamed(fault, "faultstring")[0]?.text ||
      findFirst(fault, "Text")?.text ||
      "the service returned a SOAP fault";

    // Only a transport-layer fault is a transient condition. An application
    // fault — a rejected transfer, an unknown account — will fail identically
    // on retry, and retrying a mutation on it would be the exact behaviour the
    // safety model forbids.
    const retryable = localName(code).toLowerCase() === "server";
    return { code: localName(code), message, retryable };
  },
};
