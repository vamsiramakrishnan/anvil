/**
 * WSDL 1.1 (+ embedded XSD) → OpenAPI 3.0 adapter for SOAP services.
 *
 * Each `<operation>` in a `<portType>` becomes one operation, lowered to POST
 * — the truthful wire method for every SOAP call. The *effect* is inferred
 * conservatively from the operation name: read verbs
 * (Get/List/Find/Query/Search/Retrieve/…) assert `x-anvil-effect: read`;
 * everything else stays a mutation (unsafe until
 * enriched). The input message's schema becomes the request body, the output
 * message's the response, and named XSD complex/simple types become
 * `components.schemas` referenced by `$ref` (resolved by the shared
 * dereferencer).
 *
 * The XSD subset understood here is the document/literal shape used by the vast
 * majority of real WSDLs: global elements, `complexType` with `sequence`/`all`,
 * `simpleType` with enumeration restrictions, `complexContent` extension,
 * `element ref=`, `minOccurs`/`maxOccurs`, and the built-in scalar types.
 * Multi-file trees (`wsdl:import`, `xsd:include`/`xsd:import`) resolve through
 * an injected `WsdlImportResolver` — the adapter itself never touches the
 * filesystem.
 */
import { posix } from "node:path";
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

/**
 * Build the XSD model from a set of `<schema>` elements — the embedded
 * `<types>` schemas plus any imported/included schema documents. Definitions
 * are merged by local name across all of them: `xsd:include` shares a target
 * namespace and `xsd:import` brings another one, but this lowering is
 * namespace-blind by design (matching the single-file behaviour), so both
 * reduce to "merge element/complexType/simpleType definitions".
 */
function buildXsdModel(schemas: XmlElement[]): XsdModel {
  const model: XsdModel = { elements: new Map(), namedTypes: new Map() };

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
  resolveDeferred(model);
  return model;
}

/** Marker for a complexContent/extension base, resolved after all passes. */
const EXTENSION_BASE_KEY = "x-anvil-xsd-base";
/** Marker for an `element ref="..."`, resolved after all passes. */
const ELEMENT_REF_KEY = "x-anvil-xsd-element";

/**
 * Deferred resolution of cross-references the passes above cannot see yet:
 * complexContent/extension bases and `element ref=` targets both routinely
 * point at definitions that appear later in the file or in another schema
 * document (Travelport's request elements extend base types declared across
 * three files), so they resolve only once every named type and global element
 * is registered — making the result independent of declaration order. An
 * extension becomes `allOf: [base $ref, own members]`; a ref'd element is
 * promoted to a component and referenced by `$ref`, so recursive elements
 * lower to `$ref` cycles the shared dereferencer already handles.
 */
function resolveDeferred(model: XsdModel): void {
  // Element local name → its promoted component key.
  const promoted = new Map<string, string>();
  const promote = (name: string): string => {
    const existing = promoted.get(name);
    if (existing !== undefined) return existing;
    const key = model.namedTypes.has(name) ? `${name}_Element` : name;
    promoted.set(name, key);
    model.namedTypes.set(key, model.elements.get(name) as JsonSchemaLike);
    return key;
  };

  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const schema = node as JsonSchemaLike;
    const elementRef = schema[ELEMENT_REF_KEY];
    if (typeof elementRef === "string") {
      delete schema[ELEMENT_REF_KEY];
      if (model.elements.has(elementRef)) {
        schema.$ref = `#/components/schemas/${promote(elementRef)}`;
      } else {
        schema.type = "object";
      }
    }
    const base = schema[EXTENSION_BASE_KEY];
    if (typeof base === "string") {
      delete schema[EXTENSION_BASE_KEY];
      const local = localName(base);
      if (model.namedTypes.has(local)) {
        const own: JsonSchemaLike = {};
        for (const key of Object.keys(schema)) {
          own[key] = schema[key];
          delete schema[key];
        }
        schema.allOf = [{ $ref: `#/components/schemas/${local}` }, own];
      }
    }
    for (const value of Object.values(schema)) visit(value);
  };
  for (const schema of model.namedTypes.values()) visit(schema);
  for (const schema of model.elements.values()) visit(schema);
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
    let schema = el.attrs.ref ? refElementSchema(el.attrs.ref) : elementSchema(el, model);
    const maxOccurs = el.attrs.maxOccurs;
    if (maxOccurs === "unbounded" || (maxOccurs && Number(maxOccurs) > 1)) {
      schema = { type: "array", items: schema };
    }
    properties[name] = schema;
    if (el.attrs.minOccurs !== "0") required.push(name);
  }

  // Attributes become optional scalar properties. An extension declares its
  // own attributes on the extension element itself, not on the complexType.
  const extension = childrenNamed(ct, "complexContent").flatMap((cc) =>
    childrenNamed(cc, "extension"),
  )[0];
  const attributeHosts = extension ? [ct, extension] : [ct];
  for (const host of attributeHosts) {
    for (const attr of childrenNamed(host, "attribute")) {
      const name = attr.attrs.name;
      if (!name) continue;
      properties[name] = attr.attrs.type
        ? typeRefSchema(attr.attrs.type, model)
        : { type: "string" };
    }
  }

  const out: JsonSchemaLike = { type: "object", properties };
  if (required.length > 0) out.required = required;
  // The inherited base members resolve after all passes (resolveDeferred);
  // the base type routinely appears later in the file or in another document.
  if (extension?.attrs.base) out[EXTENSION_BASE_KEY] = extension.attrs.base;
  return out;
}

/** An `element ref="..."` — deferred, since the target may not be parsed yet. */
function refElementSchema(ref: string): JsonSchemaLike {
  return { [ELEMENT_REF_KEY]: localName(ref) };
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

/* ----------------------------- import resolution ---------------------------- */

/**
 * Resolve a `wsdl:import` (`location`) or `xsd:include`/`xsd:import`
 * (`schemaLocation`) target to the referenced file's text, or undefined if it
 * isn't available. Real SOAP APIs ship as WSDL trees — Travelport's uAPI entry
 * WSDL holds only bindings and imports the portTypes/messages from an abstract
 * WSDL, whose schemas include further XSDs across sibling directories — so
 * without this the entry compiles to zero operations. Mirrors
 * `ProtoImportResolver`: same-snapshot bytes only, never an ambient host path
 * or the network. The adapter joins each location against the importing file's
 * directory before asking, so a resolver only performs lookups.
 */
export type WsdlImportResolver = (importPath: string) => string | undefined;

interface WsdlDocuments {
  /** The entry `<definitions>` first, then transitively wsdl:import'ed ones. */
  definitions: XmlElement[];
  /** Every `<schema>`: embedded `<types>` schemas plus imported XSD roots. */
  schemas: XmlElement[];
}

/**
 * Gather the entry document plus everything reachable through `wsdl:import`
 * and `xsd:include`/`xsd:import` — inside `<types>` schemas and inside the
 * included XSDs themselves (transitive). Each location is joined against the
 * importing file's directory so relative trees (`../common_v45_0/Common.xsd`)
 * resolve; the seen-set makes revisits (shared includes, cycles) no-ops. A
 * location that is remote, unresolvable, or unparseable degrades to the
 * single-file behaviour — its types stay unresolved, nothing throws.
 */
function collectDocuments(
  entry: XmlElement,
  sourcePath: string | undefined,
  resolveImport: WsdlImportResolver | undefined,
): WsdlDocuments {
  const docs: WsdlDocuments = { definitions: [entry], schemas: findAll(entry, "schema") };
  if (!resolveImport) return docs;
  const seen = new Set<string>(sourcePath !== undefined ? [posix.normalize(sourcePath)] : []);
  const visit = (root: XmlElement, fromPath: string | undefined): void => {
    for (const el of [...findAll(root, "import"), ...findAll(root, "include")]) {
      const location = el.attrs.location ?? el.attrs.schemaLocation;
      // No location (a namespace-only xsd:import) or a remote one: skip.
      if (!location || /^[a-z][a-z0-9+.-]*:/i.test(location) || location.startsWith("//")) continue;
      const candidate = posix.normalize(
        fromPath !== undefined ? posix.join(posix.dirname(fromPath), location) : location,
      );
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const text = resolveImport(candidate);
      if (text === undefined) continue;
      let imported: XmlElement;
      try {
        imported = parseXml(text);
      } catch {
        continue;
      }
      const kind = localName(imported.tag);
      if (kind === "definitions") {
        docs.definitions.push(imported);
        docs.schemas.push(...findAll(imported, "schema"));
      } else if (kind === "schema") {
        docs.schemas.push(imported);
      } else {
        continue;
      }
      visit(imported, candidate);
    }
  };
  visit(entry, sourcePath);
  return docs;
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

/** The operation identity a portType name carries: "FlightDetailsPortType" → "FlightDetails". */
function portTypeOperationName(portName: string): string {
  const stripped = portName.replace(/PortType$|Port$/, "");
  return stripped.length > 0 ? stripped : portName;
}

/**
 * Lower a WSDL 1.1 document into an OpenAPI 3.0 document (with `$ref`s), to be
 * dereferenced by the caller. When `resolveImport` is given, `wsdl:import` and
 * `xsd:include`/`xsd:import` targets are merged in (transitively) so cross-file
 * portTypes/messages/types resolve to their real shapes; a location that can't
 * be resolved degrades gracefully exactly as an unresolved type does.
 * `sourcePath` is the entry document's snapshot path — the base its relative
 * import locations are joined against. Single-file callers pass neither and
 * get the original behaviour.
 */
export function adaptWsdl(
  source: string,
  resolveImport?: WsdlImportResolver,
  sourcePath?: string,
): OpenApiDocument {
  const root = parseXml(source);
  const docs = collectDocuments(root, sourcePath, resolveImport);
  const xsd = buildXsdModel(docs.schemas);

  // Messages: name → parts, merged across the entry and every imported WSDL.
  const messages = new Map<string, WsdlMessage>();
  for (const definitions of docs.definitions) {
    for (const msg of findAll(definitions, "message")) {
      const name = msg.attrs.name;
      if (!name) continue;
      const parts = childrenNamed(msg, "part").map((p) => ({
        name: p.attrs.name ?? "body",
        element: p.attrs.element,
        type: p.attrs.type,
      }));
      messages.set(localName(name), { parts });
    }
  }

  const serviceName =
    docs.definitions.flatMap((d) => findAll(d, "service"))[0]?.attrs.name ??
    root.attrs.name ??
    "SoapService";

  const paths: Record<string, Record<string, unknown>> = {};
  const documentation = docs.definitions
    .map((d) => findAll(d, "documentation")[0]?.text)
    .find((text) => text !== undefined);

  const portTypes = docs.definitions.flatMap((d) => findAll(d, "portType"));
  // Operation-name occurrence counts across every portType. Some real WSDLs
  // (Travelport uAPI) give every portType a single operation with the same
  // generic name ("service"); a repeated name identifies nothing, so the
  // portType name must carry the operation's identity instead.
  const opNameUses = new Map<string, number>();
  for (const portType of portTypes) {
    for (const operation of childrenNamed(portType, "operation")) {
      const name = operation.attrs.name;
      if (name) opNameUses.set(name, (opNameUses.get(name) ?? 0) + 1);
    }
  }

  for (const portType of portTypes) {
    const portName = portType.attrs.name ?? serviceName;
    for (const operation of childrenNamed(portType, "operation")) {
      const opName = operation.attrs.name;
      if (!opName) continue;
      const inputRef = childrenNamed(operation, "input")[0]?.attrs.message;
      const outputRef = childrenNamed(operation, "output")[0]?.attrs.message;
      const inputMsg = inputRef ? messages.get(localName(inputRef)) : undefined;
      const outputMsg = outputRef ? messages.get(localName(outputRef)) : undefined;

      // A repeated operation name is named after its portType (minus the
      // Port/PortType suffix), and the portType name is kept out of the path
      // so it cannot leak into downstream naming as a trailing token:
      // "FlightDetailsPortType"/"service" surfaces as FlightDetails, not as a
      // `service … flight_details_port_type` collision repair.
      const generic = (opNameUses.get(opName) ?? 0) > 1;
      const effectiveName = generic ? portTypeOperationName(portName) : opName;
      // SOAP is POST-on-the-wire for every operation; the effect is asserted
      // explicitly (`x-anvil-effect` below) instead of being smuggled through a
      // fake GET — a GET with a required body is un-executable by fetch.
      const read = READ_OP.test(effectiveName);
      let path = generic ? `/${effectiveName}` : `/${portName}/${opName}`;
      if (generic && paths[path]) path = `/${portName}/${opName}`;

      const bodySchema = messageBodySchema(inputMsg, xsd);
      const responseSchema = messageBodySchema(outputMsg, xsd) ?? { type: "object" };
      const opDoc = findAll(operation, "documentation")[0]?.text;

      const op: Record<string, unknown> = {
        operationId: effectiveName,
        summary: opDoc ?? `SOAP operation ${effectiveName}`,
        tags: [generic ? effectiveName : portName],
        responses: {
          "200": {
            description: `${effectiveName} response`,
            content: { "application/json": { schema: responseSchema } },
          },
          "500": { description: "SOAP Fault" },
        },
        "x-soap-operation": opName,
        "x-soap-port-type": portName,
        // The READ_OP name test is a heuristic; classify.ts records it as an
        // adapter assertion with heuristic-grade confidence.
        ...(read ? { "x-anvil-effect": "read" } : {}),
      };
      if (bodySchema) {
        op.requestBody = {
          required: true,
          content: { "application/json": { schema: bodySchema } },
        };
      }
      paths[path] = { post: op };
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
