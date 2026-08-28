/**
 * OData ($metadata / EDMX) → OpenAPI 3.0 adapter.
 *
 * OData is the native API surface of SAP S/4HANA and ECC (and of many other
 * enterprise systems). Its `$metadata` document is an EDMX XML file describing
 * entity types, their keys, and the entity sets that expose them. This adapter
 * lowers that into the standard REST shape the rest of the Anvil pipeline
 * understands: each addressable entity set becomes the conventional CRUD paths
 *
 *   GET    /Set            → list        (read)
 *   GET    /Set({key})     → read one    (read)
 *   POST   /Set            → create      (mutation)
 *   PATCH  /Set({key})     → update      (mutation)
 *   DELETE /Set({key})     → delete      (mutation)
 *
 * so effect/risk classification, safety, and the aligned CLI/MCP/skill all fall
 * out of the ordinary REST semantics — no protocol-specific hacks downstream.
 *
 * It is namespace-blind (it matches on local element names via xml.ts), so the
 * same code lowers OData v2 — SAP's most common dialect — and v4: the structural
 * elements (EntityType, Key/PropertyRef, Property, EntityContainer, EntitySet)
 * carry the same local names in both. SAP's `sap:creatable/updatable/deletable`
 * entity-set annotations are honoured so the generated surface is truthful: an
 * entity set marked not-creatable never emits a POST.
 */
import type { Diagnostic } from "@anvil/air";
import type { OpenApiDocument } from "../parse.js";
import {
  collectOdataOperations,
  type OdataOperationModel,
  type OdataParam,
  odataVersion,
} from "./odata-operations.js";
import { childrenNamed, findAll, parseXml, type XmlElement } from "./xml.js";

type JsonSchemaLike = Record<string, unknown>;

/**
 * Local name of an EDM type reference. Unlike XML QNames (colon-prefixed), OData
 * qualifies types with a dotted namespace — `API_BUSINESS_PARTNER.A_BusinessPartner`
 * — so the identity is the segment after the last dot.
 */
function edmLocal(qname: string): string {
  const dot = qname.lastIndexOf(".");
  return dot >= 0 ? qname.slice(dot + 1) : qname;
}

/** EDM primitive → JSON Schema. Covers the OData v2 and v4 scalar sets. */
const EDM_SCALARS: Record<string, JsonSchemaLike> = {
  String: { type: "string" },
  Boolean: { type: "boolean" },
  Byte: { type: "integer", format: "int32", minimum: 0 },
  SByte: { type: "integer", format: "int32" },
  Int16: { type: "integer", format: "int32" },
  Int32: { type: "integer", format: "int32" },
  Int64: { type: "integer", format: "int64" },
  Single: { type: "number", format: "float" },
  Double: { type: "number", format: "double" },
  Decimal: { type: "number" },
  Guid: { type: "string", format: "uuid" },
  Date: { type: "string", format: "date" },
  DateTime: { type: "string", format: "date-time" },
  DateTimeOffset: { type: "string", format: "date-time" },
  Time: { type: "string" },
  TimeOfDay: { type: "string" },
  Duration: { type: "string" },
  Binary: { type: "string", format: "byte" },
  Stream: { type: "string" },
  Geography: { type: "object" },
  Geometry: { type: "object" },
};

/** Map an EDM type reference ("Edm.String", "NS.BusinessPartner") to a schema. */
function edmType(type: string | undefined, complexNames: Set<string>): JsonSchemaLike {
  if (!type) return { type: "string" };
  // Collections: `Collection(Edm.String)` / `Collection(NS.Type)`.
  const collection = /^Collection\((.+)\)$/.exec(type);
  if (collection) return { type: "array", items: edmType(collection[1], complexNames) };
  const local = edmLocal(type);
  if (type.startsWith("Edm.") || EDM_SCALARS[local]) {
    return { ...(EDM_SCALARS[local] ?? { type: "string" }) };
  }
  if (complexNames.has(local)) return { $ref: `#/components/schemas/${local}` };
  // An unknown/navigation type reference degrades to an opaque object rather
  // than dangling a $ref the dereferencer cannot resolve.
  return { type: "object", description: `OData type ${type}` };
}

interface EntityTypeModel {
  name: string;
  /** Key property names (the addressable identity). */
  keys: string[];
  /** propertyName → { schema, type } for path-param typing. */
  properties: Map<string, { schema: JsonSchemaLike; edm: string }>;
}

/** Build the JSON schema for an entity/complex type's structural properties. */
function structuralSchema(
  type: XmlElement,
  complexNames: Set<string>,
): { schema: JsonSchemaLike; props: Map<string, { schema: JsonSchemaLike; edm: string }> } {
  const properties: Record<string, JsonSchemaLike> = {};
  const required: string[] = [];
  const props = new Map<string, { schema: JsonSchemaLike; edm: string }>();
  for (const p of childrenNamed(type, "Property")) {
    const name = p.attrs.Name;
    if (!name) continue;
    const schema = edmType(p.attrs.Type, complexNames);
    if (p.attrs.MaxLength && /^\d+$/.test(p.attrs.MaxLength) && schema.type === "string") {
      schema.maxLength = Number.parseInt(p.attrs.MaxLength, 10);
    }
    if (p.attrs["sap:label"]) schema.title = p.attrs["sap:label"];
    properties[name] = schema;
    props.set(name, { schema, edm: p.attrs.Type ?? "Edm.String" });
    // Nullable defaults to true in EDM; only an explicit false marks required.
    if (p.attrs.Nullable === "false") required.push(name);
  }
  const schema: JsonSchemaLike = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return { schema, props };
}

/**
 * The same entity with its key properties removed, for an update body.
 *
 * `PATCH /Set('{BusinessPartner}')` addresses the entity by key in the path. An
 * update body that also carries `BusinessPartner` gives the agent two slots for
 * one identity, and they can disagree — which is why validation refused the
 * operation outright, leaving every OData entity set with a broken update. The
 * key is the address, not part of the payload.
 */
function withoutKeys(schema: JsonSchemaLike, keys: readonly string[]): JsonSchemaLike {
  const properties = { ...((schema.properties ?? {}) as Record<string, JsonSchemaLike>) };
  for (const key of keys) delete properties[key];
  const required = Array.isArray(schema.required)
    ? (schema.required as string[]).filter((name) => !keys.includes(name))
    : undefined;
  return {
    ...schema,
    properties,
    ...(required && required.length > 0 ? { required } : { required: undefined }),
  };
}

/** Read the key property names declared on an EntityType. */
function keyNames(type: XmlElement): string[] {
  const key = childrenNamed(type, "Key")[0];
  if (!key) return [];
  return childrenNamed(key, "PropertyRef")
    .map((r) => r.attrs.Name)
    .filter((n): n is string => Boolean(n));
}

/** A truthy SAP annotation defaults to true when absent; only "false" disables. */
function sapAllows(set: XmlElement, attr: string): boolean {
  return set.attrs[`sap:${attr}`] !== "false";
}

/**
 * The key segment an instance of this entity type is addressed by —
 * `('{ID}')`, `({Seq})`, or `(Region='{Region}',Id={Id})` — with each key as a
 * required path parameter. Identical spelling to the entity set's own item
 * path, because a bound operation and a GET address the same instance.
 */
function keySegmentOf(et: EntityTypeModel): { segment: string; params: OdataParam[] } | undefined {
  if (et.keys.length === 0) return undefined;
  const templ = (k: string) => {
    const edm = et.properties.get(k)?.edm ?? "Edm.String";
    return edmLocal(edm) === "String" ? `'{${k}}'` : `{${k}}`;
  };
  const segment =
    et.keys.length === 1
      ? `(${templ(et.keys[0] as string)})`
      : `(${et.keys.map((k) => `${k}=${templ(k)}`).join(",")})`;
  return {
    segment,
    params: et.keys.map((k) => ({
      name: k,
      type: et.properties.get(k)?.edm ?? "Edm.String",
      required: true,
    })),
  };
}

export function adaptOData(
  source: string,
  title?: string,
  diagnostics?: Diagnostic[],
): OpenApiDocument {
  const root = parseXml(source);
  const schemas = findAll(root, "Schema");

  // First pass: register every entity + complex type by local name so property
  // refs resolve, and record keys.
  const complexNames = new Set<string>();
  for (const schema of schemas) {
    for (const ct of [
      ...childrenNamed(schema, "ComplexType"),
      ...childrenNamed(schema, "EntityType"),
    ]) {
      if (ct.attrs.Name) complexNames.add(ct.attrs.Name);
    }
  }

  const components: Record<string, JsonSchemaLike> = {};
  const entityTypes = new Map<string, EntityTypeModel>();
  for (const schema of schemas) {
    for (const ct of childrenNamed(schema, "ComplexType")) {
      const name = ct.attrs.Name;
      if (name) components[name] = structuralSchema(ct, complexNames).schema;
    }
    for (const et of childrenNamed(schema, "EntityType")) {
      const name = et.attrs.Name;
      if (!name) continue;
      const { schema: s, props } = structuralSchema(et, complexNames);
      components[name] = s;
      const keys = keyNames(et);
      // A named companion rather than an inline body: the SDKs and the MCP tool
      // schema all read better with a type that has a name, and the update
      // payload genuinely is a different type from the entity.
      if (keys.length > 0) components[`${name}_Update`] = withoutKeys(s, keys);
      entityTypes.set(name, { name, keys, properties: props });
    }
  }

  const namespaceOf = (schema: XmlElement) => schema.attrs.Namespace ?? "";
  const paths: Record<string, Record<string, unknown>> = {};

  const setsByType = new Map<string, string[]>();
  for (const schema of schemas) {
    const ns = namespaceOf(schema);
    for (const container of childrenNamed(schema, "EntityContainer")) {
      for (const set of childrenNamed(container, "EntitySet")) {
        const setName = set.attrs.Name;
        if (!setName) continue;
        // EntitySet.EntityType is a namespace-qualified reference; match locally.
        const typeLocal = edmLocal(set.attrs.EntityType ?? "");
        const et = entityTypes.get(typeLocal) ?? undefined;
        if (et) setsByType.set(typeLocal, [...(setsByType.get(typeLocal) ?? []), setName]);
        buildEntitySetPaths(paths, setName, et, ns, set);
      }
    }
  }

  // The other half of the service: everything it *does*, as opposed to
  // everything it stores. Emitted after the entity sets so a function import
  // sharing a name with a set cannot displace it. The bound context is what
  // lets an instance-bound operation be addressed through the one entity set
  // that exposes its binding type.
  const version = odataVersion(root, schemas);
  const boundContext = {
    setsByType,
    keySegmentFor: (typeLocal: string) => {
      const et = entityTypes.get(typeLocal);
      return et ? keySegmentOf(et) : undefined;
    },
  };
  for (const operation of collectOdataOperations(schemas, version, diagnostics, boundContext)) {
    buildOperationPath(paths, operation, entityTypes, complexNames);
  }

  const info: Record<string, unknown> = {
    title: title ?? schemas.map(namespaceOf).find(Boolean) ?? "OData Service",
    version: "1.0.0",
  };

  return {
    openapi: "3.0.3",
    info,
    paths,
    components: { schemas: components as Record<string, unknown> },
  } as OpenApiDocument;
}

/** Emit the CRUD paths for one entity set, honouring SAP capability annotations. */
function buildEntitySetPaths(
  paths: Record<string, Record<string, unknown>>,
  setName: string,
  et: EntityTypeModel | undefined,
  namespace: string,
  set: XmlElement,
): void {
  const ref = et ? { $ref: `#/components/schemas/${et.name}` } : { type: "object" };
  // The update body drops the key properties the path already carries.
  const updateRef =
    et && et.keys.length > 0 ? { $ref: `#/components/schemas/${et.name}_Update` } : ref;
  const noun = et?.name ?? setName;
  const keys = et?.keys ?? [];
  const tag = setName;

  // Key path parameters, typed from the entity type's key properties.
  const keyParams = keys.map((k) => ({
    name: k,
    in: "path",
    required: true,
    schema: et?.properties.get(k)?.schema ?? { type: "string" },
  }));
  // OData addresses a single entity as Set(key) or Set(k1=…,k2=…); OpenAPI needs
  // a path-template segment per key. String (and v2 Guid) keys are quoted on the
  // wire — Set('0001') not Set(0001) — so the generated request is valid OData.
  const templ = (k: string) => {
    const edm = et?.properties.get(k)?.edm ?? "Edm.String";
    return edmLocal(edm) === "String" ? `'{${k}}'` : `{${k}}`;
  };
  const keySegment =
    keys.length === 1 ? templ(keys[0] as string) : keys.map((k) => `${k}=${templ(k)}`).join(",");
  const itemPath = `/${setName}(${keySegment})`;
  const collectionPath = `/${setName}`;

  const collection: Record<string, unknown> = {};
  const item: Record<string, unknown> = {};

  // list (read) — with the common OData system query options.
  if (sapAllows(set, "pageable") || keys.length > 0) {
    collection.get = {
      operationId: `list_${setName}`,
      summary: `List ${noun} entities`,
      tags: [tag],
      parameters: [
        queryParam("$filter", "string", "OData filter expression"),
        queryParam("$select", "string", "Comma-separated properties to return"),
        queryParam("$orderby", "string", "OData ordering expression"),
        { name: "$top", in: "query", required: false, schema: { type: "integer" } },
        { name: "$skip", in: "query", required: false, schema: { type: "integer" } },
      ],
      responses: okResponse(`${noun} collection`, {
        type: "object",
        properties: { value: { type: "array", items: ref } },
      }),
    };
  }

  // create (mutation).
  if (sapAllows(set, "creatable")) {
    collection.post = {
      operationId: `create_${setName}`,
      summary: `Create a ${noun}`,
      tags: [tag],
      requestBody: { required: true, content: { "application/json": { schema: ref } } },
      responses: okResponse(`Created ${noun}`, ref, "201"),
    };
  }

  if (keys.length > 0) {
    // read one (read).
    item.get = {
      operationId: `get_${setName}`,
      summary: `Read a ${noun} by key`,
      tags: [tag],
      parameters: keyParams,
      responses: okResponse(`${noun} entity`, ref),
    };
    // update (mutation).
    if (sapAllows(set, "updatable")) {
      item.patch = {
        operationId: `update_${setName}`,
        summary: `Update a ${noun}`,
        tags: [tag],
        parameters: keyParams,
        requestBody: {
          required: true,
          content: { "application/json": { schema: updateRef } },
        },
        responses: okResponse(`Updated ${noun}`, ref),
      };
    }
    // delete (mutation).
    if (sapAllows(set, "deletable")) {
      item.delete = {
        operationId: `delete_${setName}`,
        summary: `Delete a ${noun}`,
        tags: [tag],
        parameters: keyParams,
        responses: { "204": { description: `${noun} deleted` } },
      };
    }
  }

  if (Object.keys(collection).length > 0) paths[collectionPath] = collection;
  if (Object.keys(item).length > 0) paths[itemPath] = item;
  void namespace;
}

/**
 * One invocable operation — an action, a function, or a v2 function import.
 *
 * No `x-anvil-effect` is asserted anywhere here, and that is the point: the
 * verb already carries the truth. A v4 `Function` is side-effect-free by
 * specification and lowers to GET; an `Action` lowers to POST; a v2
 * `FunctionImport` lowers to whatever `m:HttpMethod` declares. Ordinary REST
 * classification then reaches the right answer with nothing adapter-specific
 * downstream — the same shape as a proto method that declared its HTTP rule.
 */
function buildOperationPath(
  paths: Record<string, Record<string, unknown>>,
  operation: OdataOperationModel,
  entityTypes: Map<string, EntityTypeModel>,
  complexNames: Set<string>,
): void {
  const returned = operation.returnType ? edmLocal(operation.returnType) : undefined;
  const collection = operation.returnType?.startsWith("Collection(") === true;
  const single =
    returned && entityTypes.has(returned)
      ? { $ref: `#/components/schemas/${returned}` }
      : returned
        ? edmType(operation.returnType as string, complexNames)
        : { type: "object" };
  const response = collection ? { type: "array", items: single } : single;

  const op: Record<string, unknown> = {
    operationId: operation.name,
    summary: `${operation.name}${operation.entitySet ? ` → ${operation.entitySet}` : ""}`,
    tags: [operation.entitySet ?? operation.name],
    responses: okResponse(`${operation.name} result`, response as JsonSchemaLike),
  };

  // Parameters bound into the coordinate. The OData literal syntax around them
  // is already part of the path text, so the runtime substitutes only the
  // value and the quotes stay literal.
  if (operation.pathParams.length > 0) {
    op.parameters = operation.pathParams.map((p) => ({
      name: p.name,
      in: "path",
      required: true,
      schema: edmType(p.type, complexNames),
    }));
  }
  if (operation.bodyParams.length > 0) {
    const properties: Record<string, JsonSchemaLike> = {};
    const required: string[] = [];
    for (const p of operation.bodyParams) {
      properties[p.name] = edmType(p.type, complexNames);
      if (p.required) required.push(p.name);
    }
    op.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: { type: "object", properties, ...(required.length > 0 ? { required } : {}) },
        },
      },
    };
  }

  paths[operation.path] = { ...(paths[operation.path] ?? {}), [operation.verb]: op };
}

function queryParam(name: string, type: string, description: string) {
  return { name, in: "query", required: false, description, schema: { type } };
}

function okResponse(description: string, schema: JsonSchemaLike, status = "200") {
  return {
    [status]: { description, content: { "application/json": { schema } } },
  };
}
