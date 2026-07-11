/**
 * WSDL 1.1 (+ embedded XSD) → OpenAPI 3.0 adapter for SOAP services.
 *
 * Each `<operation>` in a `<portType>` becomes one operation. SOAP is
 * request/response over POST, but the *effect* is inferred conservatively from
 * the operation name: read verbs (Get/List/Find/Query/Search/Retrieve/…) lower
 * to GET (read); everything else lowers to POST (mutation → unsafe until
 * enriched). The input message's schema becomes the request body, the output
 * message's the response, and named XSD complex/simple types become
 * `components.schemas` referenced by `$ref` (resolved by the shared
 * dereferencer).
 *
 * The XSD subset understood here is the document/literal shape used by the vast
 * majority of real WSDLs: global elements, `complexType` with `sequence`/`all`,
 * `simpleType` with enumeration restrictions, `minOccurs`/`maxOccurs`, and the
 * built-in scalar types.
 */
import type { OpenApiDocument } from "../parse.js";
import { childrenNamed, findAll, localName, parseXml, type XmlElement } from "./xml.js";

type JsonSchemaLike = Record<string, unknown>;

const XSD_SCALARS: Record<string, JsonSchemaLike> = {
  string: { type: "string" },
  normalizedString: { type: "string" },
  token: { type: "string" },
  anyURI: { type: "string", format: "uri" },
  QName: { type: "string" },
  language: { type: "string" },
  boolean: { type: "boolean" },
  decimal: { type: "number" },
  float: { type: "number" },
  double: { type: "number" },
  integer: { type: "integer" },
  int: { type: "integer", format: "int32" },
  long: { type: "integer", format: "int64" },
  short: { type: "integer" },
  byte: { type: "integer" },
  nonNegativeInteger: { type: "integer", minimum: 0 },
  positiveInteger: { type: "integer", minimum: 1 },
  unsignedInt: { type: "integer", minimum: 0 },
  unsignedLong: { type: "integer", minimum: 0 },
  unsignedShort: { type: "integer", minimum: 0 },
  date: { type: "string", format: "date" },
  dateTime: { type: "string", format: "date-time" },
  time: { type: "string", format: "time" },
  duration: { type: "string" },
  base64Binary: { type: "string", format: "byte" },
  hexBinary: { type: "string" },
  anyType: { type: "object" },
};

interface XsdModel {
  /** Global element local-name → its resolved schema. */
  elements: Map<string, JsonSchemaLike>;
  /** Named complex/simple type local-name → its schema (registered as components). */
  namedTypes: Map<string, JsonSchemaLike>;
}

/** Build the XSD model from every `<schema>` inside `<types>`. */
function buildXsdModel(root: XmlElement): XsdModel {
  const model: XsdModel = { elements: new Map(), namedTypes: new Map() };
  const schemas = findAll(root, "schema");

  // First pass: register named complex/simple types so refs resolve.
  for (const schema of schemas) {
    for (const ct of childrenNamed(schema, "complexType")) {
      const name = ct.attrs.name;
      if (name) model.namedTypes.set(localName(name), complexTypeSchema(ct, model));
    }
    for (const st of childrenNamed(schema, "simpleType")) {
      const name = st.attrs.name;
      if (name) model.namedTypes.set(localName(name), simpleTypeSchema(st));
    }
  }
  // Second pass: global elements (may reference the named types above).
  for (const schema of schemas) {
    for (const el of childrenNamed(schema, "element")) {
      const name = el.attrs.name;
      if (name) model.elements.set(localName(name), elementSchema(el, model));
    }
  }
  return model;
}

/** Resolve a `type="..."` QName to a JSON schema (scalar, $ref, or fallback). */
function typeRefSchema(qname: string, model: XsdModel): JsonSchemaLike {
  const local = localName(qname);
  if (XSD_SCALARS[local]) return { ...XSD_SCALARS[local] };
  if (model.namedTypes.has(local)) return { $ref: `#/components/schemas/${local}` };
  return { type: "object", description: `unresolved XSD type ${qname}` };
}

/** Schema for a global `<element>`: its named type, inline type, or object. */
function elementSchema(el: XmlElement, model: XsdModel): JsonSchemaLike {
  if (el.attrs.type) return typeRefSchema(el.attrs.type, model);
  const complex = childrenNamed(el, "complexType")[0];
  if (complex) return complexTypeSchema(complex, model);
  const simple = childrenNamed(el, "simpleType")[0];
  if (simple) return simpleTypeSchema(simple);
  return { type: "object" };
}

/** Schema for a `<complexType>` — a sequence/all/choice of child elements. */
function complexTypeSchema(ct: XmlElement, model: XsdModel): JsonSchemaLike {
  const properties: Record<string, JsonSchemaLike> = {};
  const required: string[] = [];
  // complexContent/extension is flattened best-effort by scanning descendants.
  const particles = [
    ...findAll(ct, "sequence").flatMap((s) => childrenNamed(s, "element")),
    ...findAll(ct, "all").flatMap((s) => childrenNamed(s, "element")),
    ...findAll(ct, "choice").flatMap((s) => childrenNamed(s, "element")),
  ];
  // Also capture elements that are direct children (rare, but valid).
  for (const el of childrenNamed(ct, "element")) if (!particles.includes(el)) particles.push(el);

  for (const el of particles) {
    const name = el.attrs.name
      ? localName(el.attrs.name)
      : el.attrs.ref
        ? localName(el.attrs.ref)
        : undefined;
    if (!name) continue;
    let schema = el.attrs.ref ? refElementSchema(el.attrs.ref, model) : elementSchema(el, model);
    const maxOccurs = el.attrs.maxOccurs;
    if (maxOccurs === "unbounded" || (maxOccurs && Number(maxOccurs) > 1)) {
      schema = { type: "array", items: schema };
    }
    properties[name] = schema;
    if (el.attrs.minOccurs !== "0") required.push(name);
  }

  // Attributes become optional scalar properties.
  for (const attr of childrenNamed(ct, "attribute")) {
    const name = attr.attrs.name;
    if (!name) continue;
    properties[name] = attr.attrs.type ? typeRefSchema(attr.attrs.type, model) : { type: "string" };
  }

  const out: JsonSchemaLike = { type: "object", properties };
  if (required.length > 0) out.required = required;
  return out;
}

function refElementSchema(ref: string, model: XsdModel): JsonSchemaLike {
  const local = localName(ref);
  const existing = model.elements.get(local);
  return existing ?? { type: "object" };
}

/** Schema for a `<simpleType>` — an enumerated or restricted scalar. */
function simpleTypeSchema(st: XmlElement): JsonSchemaLike {
  const restriction = findAll(st, "restriction")[0];
  const base = restriction?.attrs.base ? localName(restriction.attrs.base) : "string";
  const schema: JsonSchemaLike = { ...(XSD_SCALARS[base] ?? { type: "string" }) };
  if (restriction) {
    const enums = childrenNamed(restriction, "enumeration")
      .map((e) => e.attrs.value)
      .filter((v): v is string => v !== undefined);
    if (enums.length > 0) schema.enum = enums;
  }
  return schema;
}

/* ------------------------------- WSDL model ------------------------------- */

interface WsdlMessage {
  /** part name → { element?: QName, type?: QName }. */
  parts: { name: string; element?: string; type?: string }[];
}

const READ_OP =
  /^(get|list|find|query|search|retrieve|read|lookup|fetch|count|describe|check|is|has)/i;

function messageBodySchema(
  message: WsdlMessage | undefined,
  xsd: XsdModel,
): JsonSchemaLike | undefined {
  if (!message || message.parts.length === 0) return undefined;
  // Document/literal wrapped: a single part referencing an element whose type
  // is the actual parameter object. Surface that element's schema directly.
  if (message.parts.length === 1) {
    const part = message.parts[0] as WsdlMessage["parts"][number];
    if (part.element) {
      const el = xsd.elements.get(localName(part.element));
      if (el) return el;
    }
    if (part.type) return typeRefSchema(part.type, xsd);
  }
  // RPC style: one property per part.
  const properties: Record<string, JsonSchemaLike> = {};
  const required: string[] = [];
  for (const part of message.parts) {
    const schema = part.element
      ? (xsd.elements.get(localName(part.element)) ?? { type: "object" })
      : part.type
        ? typeRefSchema(part.type, xsd)
        : { type: "string" };
    properties[part.name] = schema;
    required.push(part.name);
  }
  return { type: "object", properties, required };
}

/**
 * Lower a WSDL 1.1 document into an OpenAPI 3.0 document (with `$ref`s), to be
 * dereferenced by the caller.
 */
export function adaptWsdl(source: string): OpenApiDocument {
  const root = parseXml(source);
  const xsd = buildXsdModel(root);

  // Messages: name → parts.
  const messages = new Map<string, WsdlMessage>();
  for (const msg of findAll(root, "message")) {
    const name = msg.attrs.name;
    if (!name) continue;
    const parts = childrenNamed(msg, "part").map((p) => ({
      name: p.attrs.name ?? "body",
      element: p.attrs.element,
      type: p.attrs.type,
    }));
    messages.set(localName(name), { parts });
  }

  const serviceName = findAll(root, "service")[0]?.attrs.name ?? root.attrs.name ?? "SoapService";

  const paths: Record<string, Record<string, unknown>> = {};
  const documentation = findAll(root, "documentation")[0]?.text;

  for (const portType of findAll(root, "portType")) {
    const portName = portType.attrs.name ?? serviceName;
    for (const operation of childrenNamed(portType, "operation")) {
      const opName = operation.attrs.name;
      if (!opName) continue;
      const inputRef = childrenNamed(operation, "input")[0]?.attrs.message;
      const outputRef = childrenNamed(operation, "output")[0]?.attrs.message;
      const inputMsg = inputRef ? messages.get(localName(inputRef)) : undefined;
      const outputMsg = outputRef ? messages.get(localName(outputRef)) : undefined;

      const read = READ_OP.test(opName);
      const httpMethod = read ? "get" : "post";
      const path = `/${portName}/${opName}`;

      const bodySchema = messageBodySchema(inputMsg, xsd);
      const responseSchema = messageBodySchema(outputMsg, xsd) ?? { type: "object" };
      const opDoc = findAll(operation, "documentation")[0]?.text;

      const op: Record<string, unknown> = {
        operationId: opName,
        summary: opDoc ?? `SOAP operation ${opName}`,
        tags: [portName],
        responses: {
          "200": {
            description: `${opName} response`,
            content: { "application/json": { schema: responseSchema } },
          },
          "500": { description: "SOAP Fault" },
        },
        "x-soap-operation": opName,
        "x-soap-port-type": portName,
      };
      if (bodySchema) {
        op.requestBody = {
          required: true,
          content: { "application/json": { schema: bodySchema } },
        };
      }
      paths[path] = { [httpMethod]: op };
    }
  }

  const schemas: Record<string, JsonSchemaLike> = {};
  for (const [name, schema] of xsd.namedTypes) schemas[name] = schema;

  return {
    openapi: "3.0.3",
    info: {
      title: serviceName,
      version: "1.0.0",
      ...(documentation ? { description: documentation } : {}),
    },
    paths,
    components: { schemas: schemas as Record<string, unknown> },
  };
}
