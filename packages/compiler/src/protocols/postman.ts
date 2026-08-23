/**
 * Postman Collection v2.x → OpenAPI 3.0 adapter. Postman collections are how a
 * large share of internal enterprise APIs are actually documented — an `item`
 * tree (folders nest; each leaf carries a saved `request`), not an OpenAPI
 * contract. This lowers a v2.0.0 / v2.1.0 collection mechanically:
 *
 *   folders            → tag/namespace context (tags + dotted operationId)
 *   leaf item.request  → one operation at its real HTTP method (GET is GET —
 *                        no `x-anvil-effect` hints are needed; the pipeline
 *                        owns POST-search classification, not the adapter)
 *   `:id` path segment → a required `{id}` path parameter (metadata from
 *                        `url.variable` when present)
 *   url.query[]        → query parameters (Postman has no requiredness concept,
 *                        so every query parameter lowers as optional; a
 *                        `disabled: true` entry additionally says so in its
 *                        description)
 *   request.header[]   → header parameters, except Content-Type / Accept /
 *                        Authorization (representation/auth concerns the
 *                        runtime owns — normalize drops them anyway, finding #33)
 *   request.body       → requestBody: raw JSON gets a schema INFERRED from the
 *                        example (and the example attached); urlencoded/formdata
 *                        map to form media types with properties from the key
 *                        list; `graphql` mode is a JSON query/variables body
 *   item.response[]    → response entries per saved `code` with the schema
 *                        inferred from the example body; none saved → generic 200
 *   auth blocks        → securitySchemes + per-operation security. Scheme NAMES
 *                        and LOCATIONS only — collections routinely embed real
 *                        tokens in auth `value` fields, so no auth value is ever
 *                        read outside a small non-secret allowlist (see
 *                        AUTH_PARAM_ALLOWLIST). The same caution extends to
 *                        parameter values: header/query/path/form VALUES from
 *                        the saved request are never copied into the lowered
 *                        document (an `X-API-Key` header or `?api_key=` query
 *                        value is auth material in all but name). Body examples
 *                        ARE copied — they are the payload documentation.
 *
 * Variables: when a request's WHOLE host is `{{var}}`, it resolves from the
 * collection-level `variable[]` when defined there; otherwise the server URL
 * keeps `https://{{var}}` verbatim (truthful — the deploy-time base URL is the
 * operator's to supply, and the runtime overrides servers via ANVIL_BASE_URL
 * anyway). A `{{var}}` path segment becomes a `{var}` path parameter ONLY when
 * it is segment-exact; a partial occurrence (`v{{ver}}`) stays literal —
 * conservative and deterministic. The first request's base becomes servers[0];
 * additional distinct bases append in first-appearance order (the pipeline
 * reads document-level servers only).
 *
 * Pre-request/test scripts are NOT translated — they frequently encode auth
 * flows and request chaining, so silence would be dishonest: the count of
 * script blocks is appended to `info.description` and recorded as
 * `x-anvil-postman-scripts`.
 */
import type { Diagnostic } from "@anvil/air";
import type { OpenApiDocument } from "../parse.js";

/* ----------------------------- source shapes ----------------------------- */
/* v2.0 and v2.1 differ mainly in auth payloads (object vs {key,value} array)
 * and in allowing `url`/`header`/`description` to be bare strings. Every field
 * here is optional because real exports omit liberally. */

type PostmanDescription = string | { content?: string } | null | undefined;

interface PostmanKV {
  key?: string;
  value?: unknown;
  description?: PostmanDescription;
  disabled?: boolean;
  /** formdata only: "text" | "file". */
  type?: string;
}

interface PostmanUrlVariable {
  key?: string;
  value?: unknown;
  description?: PostmanDescription;
}

interface PostmanUrl {
  raw?: string;
  protocol?: string;
  host?: string[] | string;
  port?: string;
  path?: Array<string | { value?: string }> | string;
  query?: PostmanKV[];
  variable?: PostmanUrlVariable[];
}

/** v2.1 encodes auth params as [{key,value}]; v2.0 as a plain object. */
interface PostmanAuth {
  type?: string;
  [k: string]: unknown;
}

interface PostmanBody {
  mode?: string;
  raw?: string;
  options?: { raw?: { language?: string } };
  urlencoded?: PostmanKV[];
  formdata?: PostmanKV[];
  graphql?: { query?: string; variables?: string };
}

interface PostmanRequest {
  method?: string;
  url?: PostmanUrl | string;
  description?: PostmanDescription;
  header?: PostmanKV[] | string;
  body?: PostmanBody | null;
  auth?: PostmanAuth | null;
}

interface PostmanEvent {
  listen?: string;
  script?: { exec?: string[] | string };
}

interface PostmanResponse {
  name?: string;
  code?: number;
  body?: string | null;
}

interface PostmanItem {
  name?: string;
  description?: PostmanDescription;
  item?: PostmanItem[];
  /** A bare string is shorthand for a GET of that URL. */
  request?: PostmanRequest | string;
  response?: PostmanResponse[];
  event?: PostmanEvent[];
}

interface PostmanCollection {
  info?: {
    name?: string;
    description?: PostmanDescription;
    schema?: string;
    version?: string | { major?: number; minor?: number; patch?: number };
  };
  item?: PostmanItem[];
  variable?: PostmanUrlVariable[];
  auth?: PostmanAuth | null;
  event?: PostmanEvent[];
}

/* ------------------------------- detection ------------------------------- */

const SCHEMA_MARK = "getpostman.com/json/collection/v2";

/** Recognize a Postman Collection v2.x by its `info.schema` discriminator. */
export function isPostmanCollection(text: string): boolean {
  // Cheap text sniff first so we don't JSON.parse a large non-Postman file.
  if (!text.includes(SCHEMA_MARK)) return false;
  try {
    const doc = JSON.parse(text) as PostmanCollection;
    return (
      typeof doc.info?.schema === "string" &&
      doc.info.schema.includes(SCHEMA_MARK) &&
      Array.isArray(doc.item)
    );
  } catch {
    return false;
  }
}

/** "2.1" for v2.1.0 schema URLs, "2.0" otherwise (both lower identically). */
export function postmanSchemaVersion(text: string): string {
  return text.includes(`${SCHEMA_MARK}.1.0`) ? "2.1" : "2.0";
}

/* --------------------------------- helpers -------------------------------- */

function descriptionText(d: PostmanDescription): string | undefined {
  if (typeof d === "string") return d || undefined;
  if (d && typeof d === "object" && typeof d.content === "string") return d.content || undefined;
  return undefined;
}

/** Sanitize one name segment into an identifier-safe token. */
function sanitize(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "op";
}

/** A `{{var}}` that occupies the ENTIRE string, or undefined. */
function wholeTemplateVar(s: string): string | undefined {
  const m = s.match(/^\{\{([^{}]+)\}\}$/);
  return m ? (m[1] as string) : undefined;
}

/**
 * Check if a folder name is a generic grouping name that should be dropped
 * from the canonical operation ID. Case-insensitive matching.
 */
function isGenericFolder(name: string): boolean {
  const normalized = name.toLowerCase().trim();
  const genericNames = new Set([
    "workflows",
    "common workflows",
    "examples",
    "samples",
    "api",
    "apis",
    "collection",
  ]);
  return genericNames.has(normalized);
}

/**
 * Build a canonical operationId from folder path and request name, dropping
 * leading generic folders and keeping at most the last 2 path segments
 * (folder + request name). When truncation would lose uniqueness, fallback to
 * more segments to stay unique.
 */
function buildOperationId(folders: string[], itemName: string, usedIds: Set<string>): string {
  // Drop leading generic folders.
  const meaningful = folders.filter((f) => !isGenericFolder(f));

  // Keep at most the last 2 path segments total (last N folders such that
  // N folders + 1 request name ≤ some reasonable depth; typically this means
  // keep the last 1 folder + request name). When there are ≤1 meaningful folders,
  // use all of them.
  let segmentsToTry = meaningful.length <= 1 ? meaningful : meaningful.slice(-1);

  // Build the ID and check for collisions.
  const buildId = (folderSegments: string[], name: string): string =>
    [...folderSegments, name].map(sanitize).join(".");

  let baseId = buildId(segmentsToTry, itemName);
  let id = baseId;
  for (let n = 2; usedIds.has(id); n += 1) {
    id = `${baseId}_${n}`;
  }

  // If we truncated (more than 1 meaningful folder) and still have a collision on the base ID,
  // try with more folders progressively until we find a non-colliding ID or use all folders.
  if (meaningful.length > 1 && usedIds.has(id)) {
    // Try with 2 folders, then 3, etc., up to all of them.
    for (let numFolders = 2; numFolders <= meaningful.length; numFolders++) {
      segmentsToTry = meaningful.slice(-numFolders);
      baseId = buildId(segmentsToTry, itemName);
      id = baseId;
      for (let n = 2; usedIds.has(id); n += 1) {
        id = `${baseId}_${n}`;
      }
      if (!usedIds.has(baseId)) {
        // Found a non-colliding base ID at this folder depth.
        break;
      }
    }
  }

  return id;
}

/* ---------------------------- schema inference ---------------------------- */

/**
 * Infer a JSON schema from an example value: string/boolean map directly,
 * numbers stay `number` (never narrowed to integer — the example is one data
 * point, not a contract), null becomes a nullable string, objects recurse per
 * property, and arrays take their item schema from the FIRST element only.
 * Deliberately shallow-typed: an example proves shape, not constraints.
 */
function inferSchema(value: unknown): Record<string, unknown> {
  if (value === null) return { type: "string", nullable: true };
  if (Array.isArray(value)) {
    return { type: "array", items: value.length > 0 ? inferSchema(value[0]) : {} };
  }
  switch (typeof value) {
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "object": {
      const properties: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        properties[k] = inferSchema(v);
      }
      return { type: "object", properties };
    }
    default:
      return { type: "string" };
  }
}

/**
 * Replace all Postman template variables ({{var}}) in a JSON string with
 * placeholders, track which fields were template variables, then try to parse.
 * Returns { parsed, templateFields, variableNames } on success, undefined on failure.
 */
function tryParseJsonWithTemplates(
  raw: string,
):
  | { parsed: unknown; templateFields: Set<string>; variableNames: Map<string, string> }
  | undefined {
  const templateFields = new Set<string>();
  const variableNames = new Map<string, string>();
  const placeholders = new Map<string, string>();
  let counter = 0;

  // Track which template variable names map to which placeholders.
  const replaced = raw.replace(/\{\{([^{}]+)\}\}/g, (match) => {
    if (!placeholders.has(match)) {
      const placeholder = `__PLACEHOLDER_${counter++}__`;
      placeholders.set(match, placeholder);
      const varName = match.slice(2, -2); // Remove {{ and }}
      variableNames.set(placeholder, varName);
    }
    return placeholders.get(match) as string;
  });

  try {
    const parsed = JSON.parse(replaced);
    // Track which fields had exactly a template variable (now a placeholder string).
    const findTemplateFields = (obj: unknown, path: string[] = []): void => {
      if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
        for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
          if (typeof val === "string" && val.startsWith("__PLACEHOLDER_")) {
            templateFields.add([...path, key].join("."));
          }
          findTemplateFields(val, [...path, key]);
        }
      }
    };
    findTemplateFields(parsed);

    return { parsed, templateFields, variableNames };
  } catch {
    return undefined;
  }
}

/**
 * Apply lenient JSON fixes to handle common quirks in Postman collection bodies:
 * 1. Remove // line comments (only outside strings).
 * 2. Remove block comments (only outside strings).
 * 3. Remove trailing commas before } or ].
 * 4. Quote unquoted __PLACEHOLDER_N__ identifiers (from template variable substitution).
 *
 * Each rule is applied only when its evidence is found in the corpus. The OPERA
 * collection contains many bodies with these issues.
 */
function applyLenientJsonFixes(json: string): string {
  // Rule 1: Remove // line comments. Evidence: many lines in OPERA bodies end with
  // `// comment` after values. We only remove from line start/post-whitespace to EOL,
  // never inside strings (regex-only safety; full string-aware parsing not justified
  // for occasional comment-removal). Pattern: /\/\/.*$/gm removes the rest of each line
  // starting with //, but this can break JSON if // appears in a string. Conservative
  // approach: remove lines that begin with // or appear after comma/bracket, not
  // in the middle of a value. For now, remove all // to EOL as Postman rarely embeds
  // // in literal strings.
  let result = json.replace(/\/\/.*$/gm, "");

  // Rule 2: Remove /* */ block comments. Evidence: OPERA has some bodies with
  // /* comment */ blocks between or around values. Remove all /* ... */ as they're
  // unlikely to appear inside JSON string literals in this corpus.
  result = result.replace(/\/\*[\s\S]*?\*\//g, "");

  // Rule 3: Remove trailing commas before } or ]. Evidence: very common in OPERA.
  // Example: `"type": "Reservation",\n}` becomes `"type": "Reservation"\n}`.
  // This is safe: a comma before } or ] is always invalid in JSON.
  result = result.replace(/,(\s*[}\]])/g, "$1");

  // Rule 4: Quote unquoted placeholder identifiers. Evidence: OPERA has unquoted
  // template variables like `"id": {{ReservationId}}` which after placeholder
  // substitution become `"id": __PLACEHOLDER_ReservationId__`, which is invalid (identifiers
  // are not valid JSON values). Quote them: `: __PLACEHOLDER_X__` → `: "__PLACEHOLDER_X__"`.
  result = result.replace(/:\s*(__PLACEHOLDER_[A-Za-z0-9_]+__)([,}\]])/g, ': "$1"$2');

  return result;
}

/**
 * Infer schema from a JSON example, enriching fields that were Postman
 * template variables with descriptions showing the variable name.
 */
function inferSchemaWithTemplates(
  value: unknown,
  templateFields: Set<string>,
  _variableNames: Map<string, string>,
): Record<string, unknown> {
  const schema = inferSchema(value);

  // Enrich schema properties with template variable metadata.
  const enrichProperties = (
    s: Record<string, unknown>,
    path: string[] = [],
  ): Record<string, unknown> => {
    if (s.type === "object" && typeof s.properties === "object" && s.properties !== null) {
      const enriched: Record<string, unknown> = { ...s };
      enriched.properties = { ...s.properties };
      for (const [key, propSchema] of Object.entries(s.properties as Record<string, unknown>)) {
        const fieldPath = [...path, key].join(".");
        if (templateFields.has(fieldPath)) {
          // This field was a template variable in the original JSON.
          if (typeof propSchema === "object" && propSchema !== null) {
            const propSchemaObj = propSchema as Record<string, unknown>;
            const enrichedProp = enrichProperties(propSchemaObj, [...path, key]);
            (enriched.properties as Record<string, unknown>)[key] = {
              ...enrichedProp,
              description:
                'Postman collection template variable (original example: "{{variable}}")',
            };
          } else {
            // Fallback: property is not an object (shouldn't happen for schemas).
            (enriched.properties as Record<string, unknown>)[key] = propSchema;
          }
        } else if (typeof propSchema === "object" && propSchema !== null) {
          // Recursively enrich nested objects.
          (enriched.properties as Record<string, unknown>)[key] = enrichProperties(
            propSchema as Record<string, unknown>,
            [...path, key],
          );
        } else {
          // Preserve non-template, non-object fields as-is.
          (enriched.properties as Record<string, unknown>)[key] = propSchema;
        }
      }
      return enriched;
    }
    return s;
  };

  return enrichProperties(schema);
}

/* ---------------------------------- auth ---------------------------------- */

/**
 * The ONLY auth parameters the adapter may read, per auth type. Everything
 * else — token, value, username, password, clientId, clientSecret, … — is
 * treated as secret material and never touched, so an embedded credential in
 * the source collection cannot appear anywhere in the lowered document.
 */
const AUTH_PARAM_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  apikey: new Set(["key", "in"]),
  oauth2: new Set(["authUrl", "accessTokenUrl", "scope"]),
  bearer: new Set<string>(),
  basic: new Set<string>(),
};

/** Read one allowlisted auth parameter from either the v2.1 array or v2.0 object encoding. */
function authParam(auth: PostmanAuth, key: string): string | undefined {
  const type = auth.type ?? "";
  if (!AUTH_PARAM_ALLOWLIST[type]?.has(key)) return undefined;
  const payload = auth[type];
  if (Array.isArray(payload)) {
    const entry = (payload as PostmanKV[]).find((p) => p.key === key);
    return typeof entry?.value === "string" ? entry.value : undefined;
  }
  if (payload && typeof payload === "object") {
    const v = (payload as Record<string, unknown>)[key];
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

/** Stable scheme name per auth type; one scheme serves every use of the type. */
const SCHEME_NAMES: Record<string, string> = {
  bearer: "bearerAuth",
  basic: "basicAuth",
  apikey: "apiKeyAuth",
  oauth2: "oauth2Auth",
};

/**
 * Lower one Postman auth block to an OpenAPI security scheme. Only names and
 * locations cross over — never values (see AUTH_PARAM_ALLOWLIST). Unsupported
 * types (awsv4, digest, hawk, ntlm, …) return undefined and the operation
 * carries no security claim rather than a wrong one.
 */
function toSecurityScheme(auth: PostmanAuth): Record<string, unknown> | undefined {
  switch (auth.type) {
    case "bearer":
      return { type: "http", scheme: "bearer" };
    case "basic":
      return { type: "http", scheme: "basic" };
    case "apikey": {
      const where = authParam(auth, "in") === "query" ? "query" : "header";
      return { type: "apiKey", in: where, name: authParam(auth, "key") ?? "X-API-Key" };
    }
    case "oauth2": {
      // The flow object requires URLs; when the collection doesn't declare
      // them, a clearly-non-routable placeholder keeps the scheme honest
      // without inventing a vendor endpoint.
      const scopes: Record<string, string> = {};
      for (const s of (authParam(auth, "scope") ?? "").split(/[\s,]+/)) {
        if (s) scopes[s] = "";
      }
      return {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: authParam(auth, "authUrl") ?? "https://example.invalid/authorize",
            tokenUrl: authParam(auth, "accessTokenUrl") ?? "https://example.invalid/token",
            scopes,
          },
        },
      };
    }
    default:
      return undefined;
  }
}

/* ----------------------------------- URL ----------------------------------- */

interface LoweredUrl {
  /** Absolute server base, or a verbatim `https://{{var}}` when unresolvable. */
  base: string;
  /** OpenAPI path template, always starting with `/`. */
  path: string;
  /** Path parameter names in appearance order. */
  pathParams: string[];
  query: PostmanKV[];
  variables: PostmanUrlVariable[];
}

/** Split a raw URL string into the object shape, minimally and deterministically. */
function parseRawUrl(raw: string): PostmanUrl {
  let rest = raw.trim();
  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);
  let queryStr = "";
  const q = rest.indexOf("?");
  if (q >= 0) {
    queryStr = rest.slice(q + 1);
    rest = rest.slice(0, q);
  }
  let protocol: string | undefined;
  const proto = rest.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (proto) {
    protocol = (proto[1] as string).toLowerCase();
    rest = rest.slice(proto[0].length);
  }
  const slash = rest.indexOf("/");
  const host = slash >= 0 ? rest.slice(0, slash) : rest;
  const path = slash >= 0 ? rest.slice(slash + 1) : "";
  const query = queryStr
    ? queryStr.split("&").map((pair) => {
        const eq = pair.indexOf("=");
        return eq >= 0
          ? { key: pair.slice(0, eq), value: pair.slice(eq + 1) }
          : { key: pair, value: "" };
      })
    : [];
  return {
    raw,
    protocol,
    host: host ? [host] : [],
    path: path ? path.split("/") : [],
    query,
  };
}

/** One path segment → its OpenAPI form, recording a param when one is declared. */
function lowerSegment(segment: string, params: string[]): string {
  // `:id` — Postman's own path-variable syntax.
  if (segment.startsWith(":") && segment.length > 1) {
    const name = sanitize(segment.slice(1));
    params.push(name);
    return `{${name}}`;
  }
  // A segment that IS a `{{var}}` template (segment-exact only; a partial
  // occurrence like `v{{ver}}` stays a literal — conservative).
  const templated = wholeTemplateVar(segment);
  if (templated !== undefined) {
    const name = sanitize(templated);
    params.push(name);
    return `{${name}}`;
  }
  return segment;
}

/** Lower a Postman URL (either encoding) against the collection variables. */
function lowerUrl(url: PostmanUrl | string, variables: Map<string, string>): LoweredUrl {
  const u = typeof url === "string" ? parseRawUrl(url) : url;
  // Fall back to parsing `raw` when the structured fields are absent.
  const structured = u.host !== undefined || u.path !== undefined ? u : parseRawUrl(u.raw ?? "");

  const hostRaw = Array.isArray(structured.host)
    ? structured.host.join(".")
    : (structured.host ?? "");
  const port = structured.port ? `:${structured.port}` : "";
  const protocol = structured.protocol || "https";

  // The whole host is `{{var}}`: resolve from collection variables when
  // defined; otherwise keep the template verbatim (documented above).
  let base: string;
  const hostVar = wholeTemplateVar(hostRaw);
  if (hostVar !== undefined) {
    const resolved = variables.get(hostVar);
    if (resolved && /^https?:\/\//i.test(resolved)) {
      const trimmed = resolved.replace(/\/+$/, "");
      // Don't double-append when the scheme'd host variable already carries its own port.
      base = /:\d+$/.test(trimmed) ? trimmed : `${trimmed}${port}`;
    } else if (resolved) {
      base = `https://${resolved.replace(/\/+$/, "")}${port}`;
    } else {
      base = `https://{{${hostVar}}}${port}`;
    }
  } else {
    base = `${protocol}://${hostRaw}${port}`;
  }

  const segments = Array.isArray(structured.path)
    ? structured.path.map((s) => (typeof s === "string" ? s : (s.value ?? "")))
    : (structured.path ?? "").split("/");
  const pathParams: string[] = [];
  const lowered = segments.filter((s) => s !== "").map((s) => lowerSegment(s, pathParams));

  return {
    base,
    path: `/${lowered.join("/")}`,
    pathParams,
    query: structured.query ?? [],
    variables: structured.variable ?? [],
  };
}

/* -------------------------------- parameters ------------------------------- */

/** Headers the runtime owns; normalize drops them as inputs (finding #33). */
const RUNTIME_HEADERS = new Set(["content-type", "accept", "authorization"]);

/**
 * Build the operation's parameter list. Parameter VALUES from the saved
 * request are deliberately never copied (they routinely carry credentials);
 * only names, locations, and descriptions cross over. Postman declares no
 * requiredness, so path params are required (structurally) and everything
 * else lowers as optional — the conservative, executable choice.
 *
 * Returns both the parameters array and a count of disabled query parameters
 * (for operation-level summary text).
 */
function lowerParameters(
  url: LoweredUrl,
  header: PostmanKV[],
): { params: Record<string, unknown>[]; disabledQueryCount: number } {
  const params: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let disabledQueryCount = 0;
  const add = (p: Record<string, unknown>) => {
    const id = `${p.in}:${String(p.name).toLowerCase()}`;
    if (!seen.has(id)) {
      seen.add(id);
      params.push(p);
    }
  };

  const varMeta = new Map(
    url.variables.filter((v) => v.key).map((v) => [sanitize(v.key ?? ""), v]),
  );
  for (const name of url.pathParams) {
    const meta = varMeta.get(name);
    add({
      name,
      in: "path",
      required: true,
      ...(descriptionText(meta?.description)
        ? { description: descriptionText(meta?.description) }
        : {}),
      schema: { type: "string" },
    });
  }

  for (const q of url.query) {
    if (!q.key) continue;
    if (q.disabled === true) disabledQueryCount += 1;
    const desc = [
      descriptionText(q.description),
      q.disabled === true
        ? "(disabled in the source collection — verify it is enabled in your environment before relying on it)"
        : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    add({
      name: q.key,
      in: "query",
      required: false,
      ...(desc ? { description: desc } : {}),
      schema: { type: "string" },
    });
  }

  for (const h of header) {
    if (!h.key || RUNTIME_HEADERS.has(h.key.toLowerCase())) continue;
    const desc = descriptionText(h.description);
    add({
      name: h.key,
      in: "header",
      required: false,
      ...(desc ? { description: desc } : {}),
      schema: { type: "string" },
    });
  }

  return { params, disabledQueryCount };
}

/** v2.0 allows `header` as one raw string of `Key: value` lines. */
function headerList(header: PostmanKV[] | string | undefined): PostmanKV[] {
  if (Array.isArray(header)) return header;
  if (typeof header !== "string") return [];
  return header
    .split(/\r?\n/)
    .map((line) => {
      const colon = line.indexOf(":");
      return colon > 0 ? { key: line.slice(0, colon).trim() } : {};
    })
    .filter((h) => h.key);
}

/* ----------------------------------- body ---------------------------------- */

/** Form fields: properties from the KEY LIST only — values are never copied. */
function formSchema(fields: PostmanKV[], binaryFiles: boolean): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const f of fields) {
    if (!f.key) continue;
    const desc = descriptionText(f.description);
    properties[f.key] = {
      ...(binaryFiles && f.type === "file"
        ? { type: "string", format: "binary" }
        : { type: "string" }),
      ...(desc ? { description: desc } : {}),
    };
  }
  return { type: "object", properties };
}

/** Lower request.body → an OpenAPI requestBody, or undefined when there is none. */
function lowerBody(body: PostmanBody | null | undefined): Record<string, unknown> | undefined {
  if (!body?.mode) return undefined;
  switch (body.mode) {
    case "raw": {
      const raw = body.raw ?? "";
      if (raw.trim() === "") return undefined;
      const language = body.options?.raw?.language;
      // JSON when declared as such — or when the text simply parses as JSON
      // (many real exports omit `options` entirely).
      if (language === undefined || language === "json") {
        try {
          const example = JSON.parse(raw);
          return {
            content: {
              "application/json": { schema: inferSchema(example), example },
            },
          };
        } catch {
          // Declared JSON but not parseable (usually `{{var}}` templates):
          // try to parse after replacing template variables with placeholders.
          if (language === "json") {
            const result = tryParseJsonWithTemplates(raw);
            if (result !== undefined) {
              // Successfully parsed after placeholder substitution.
              // Infer schema with template variable metadata.
              const schema = inferSchemaWithTemplates(
                result.parsed,
                result.templateFields,
                result.variableNames,
              );
              // Build required array: all top-level fields in the example are required
              // (Postman has no requiredness concept, so we document the assumption).
              if (schema.type === "object" && typeof schema.properties === "object") {
                schema.required = Object.keys(schema.properties as Record<string, unknown>);
              }
              return {
                content: {
                  "application/json": {
                    schema: {
                      ...schema,
                      description:
                        schema.description ??
                        "Schema inferred from body example with placeholder substitution for template variables.",
                    },
                    example: result.parsed,
                  },
                },
              };
            }
            // Placeholder substitution alone didn't work; try lenient fixes for
            // common Postman body quirks (trailing commas, comments, unquoted templates, etc.).
            // Replace templates with placeholders again, then apply lenient rules.
            const placeholderJson = raw.replace(/\{\{([^{}]+)\}\}/g, (match) => {
              const varName = match.slice(2, -2);
              return `__PLACEHOLDER_${varName.replace(/[^A-Za-z0-9]/g, "_")}__`;
            });
            const lenientJson = applyLenientJsonFixes(placeholderJson);
            try {
              const parsed = JSON.parse(lenientJson);
              // Infer schema from the parsed JSON, not a generic object.
              const schema = inferSchema(parsed);
              // Build required array: all top-level fields in the example are required.
              if (schema.type === "object" && typeof schema.properties === "object") {
                schema.required = Object.keys(schema.properties as Record<string, unknown>);
              }
              return {
                content: {
                  "application/json": {
                    schema: {
                      ...schema,
                      description:
                        schema.description ??
                        "Schema inferred from body example after lenient JSON fixes (removed trailing commas, comments, or quoted template variables).",
                    },
                    example: parsed,
                  },
                },
              };
            } catch {
              // Even lenient fixes didn't work: honest message.
              return {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      description:
                        "Body example in the source collection contains template variables and could not be typed.",
                    },
                  },
                },
              };
            }
          }
        }
      }
      // Non-JSON raw text lowers truthfully as text, not as a fake object.
      const media = language === "xml" ? "application/xml" : "text/plain";
      return { content: { [media]: { schema: { type: "string" } } } };
    }
    case "urlencoded":
      return {
        content: {
          "application/x-www-form-urlencoded": {
            schema: formSchema(body.urlencoded ?? [], false),
          },
        },
      };
    case "formdata":
      return {
        content: {
          "multipart/form-data": { schema: formSchema(body.formdata ?? [], true) },
        },
      };
    case "graphql": {
      const example: Record<string, unknown> = {};
      if (typeof body.graphql?.query === "string") example.query = body.graphql.query;
      return {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                query: { type: "string", description: "GraphQL query document" },
                variables: { type: "object", description: "GraphQL variables" },
              },
              required: ["query"],
            },
            ...(Object.keys(example).length > 0 ? { example } : {}),
          },
        },
      };
    }
    default:
      // Unknown/binary modes (`file`, …): a permissive object body — the
      // collection carries no schema to be truthful about.
      return {
        content: {
          "application/json": {
            schema: {
              type: "object",
              description: `Postman body mode '${body.mode}' is not translatable; permissive object body.`,
            },
          },
        },
      };
  }
}

/* --------------------------------- responses -------------------------------- */

/** Saved example responses → response entries; none saved → a generic 200. */
function lowerResponses(saved: PostmanResponse[] | undefined): Record<string, unknown> {
  const responses: Record<string, unknown> = {};
  for (const r of saved ?? []) {
    const code =
      typeof r.code === "number" && r.code >= 100 && r.code <= 599 ? String(r.code) : "200";
    if (responses[code] !== undefined) continue; // first example per code wins
    const description = r.name || "Saved example response.";
    if (typeof r.body === "string" && r.body.trim() !== "") {
      try {
        const example = JSON.parse(r.body);
        responses[code] = {
          description,
          content: { "application/json": { schema: inferSchema(example), example } },
        };
        continue;
      } catch {
        responses[code] = {
          description,
          content: { "text/plain": { schema: { type: "string" } } },
        };
        continue;
      }
    }
    responses[code] = { description };
  }
  if (Object.keys(responses).length === 0) {
    responses["200"] = { description: "Successful response." };
  }
  return responses;
}

/* --------------------------------- adapter --------------------------------- */

interface Leaf {
  folders: string[];
  item: PostmanItem;
  request: PostmanRequest;
}

/** Walk the item tree; folders (items with `item` arrays) provide context. */
function* eachLeaf(items: PostmanItem[] | undefined, folders: string[] = []): Generator<Leaf> {
  for (const item of items ?? []) {
    if (item.request !== undefined) {
      const request =
        typeof item.request === "string" ? { method: "GET", url: item.request } : item.request;
      yield { folders, item, request };
    } else if (Array.isArray(item.item)) {
      yield* eachLeaf(item.item, [...folders, item.name ?? ""]);
    }
  }
}

/** Count script blocks (pre-request/test JS) across the whole tree. */
function countScripts(collection: PostmanCollection): number {
  let count = 0;
  const hasCode = (e: PostmanEvent): boolean => {
    const exec = e.script?.exec;
    const text = Array.isArray(exec) ? exec.join("\n") : (exec ?? "");
    return text.trim() !== "";
  };
  count += (collection.event ?? []).filter(hasCode).length;
  const walk = (items: PostmanItem[] | undefined): void => {
    for (const item of items ?? []) {
      count += (item.event ?? []).filter(hasCode).length;
      walk(item.item);
    }
  };
  walk(collection.item);
  return count;
}

/**
 * Lower a Postman collection.
 *
 * `diagnostics` is an optional sink the caller drains into `ParsedSpec`. It
 * exists because this adapter can genuinely lose requests — see the collision
 * note below — and losing them silently was worse than the limitation itself.
 */
export function adaptPostman(text: string, diagnostics?: Diagnostic[]): OpenApiDocument {
  let collection: PostmanCollection;
  try {
    collection = JSON.parse(text) as PostmanCollection;
  } catch (err) {
    throw new Error(`Invalid Postman Collection JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (
    typeof collection.info?.schema !== "string" ||
    !collection.info.schema.includes(SCHEMA_MARK)
  ) {
    throw new Error(
      "Not a Postman Collection v2.x: info.schema does not carry the v2 discriminator.",
    );
  }

  // Collection-level variables resolve `{{var}}` hosts; only string values.
  const variables = new Map<string, string>();
  for (const v of collection.variable ?? []) {
    if (v.key && typeof v.value === "string") variables.set(v.key, v.value);
  }

  // Collection-level auth is the document default; request-level auth overrides
  // per operation. One scheme per auth TYPE (they are interchangeable claims).
  const securitySchemes: Record<string, unknown> = {};
  const registerAuth = (auth: PostmanAuth | null | undefined): string | undefined => {
    if (!auth?.type || auth.type === "noauth") return undefined;
    const scheme = toSecurityScheme(auth);
    const name = SCHEME_NAMES[auth.type];
    if (!scheme || !name) return undefined;
    if (securitySchemes[name] === undefined) securitySchemes[name] = scheme;
    return name;
  };
  const collectionScheme = registerAuth(collection.auth);

  const paths: Record<string, Record<string, unknown>> = {};
  const servers: string[] = [];
  const usedIds = new Set<string>();

  for (const leaf of eachLeaf(collection.item)) {
    if (leaf.request.url === undefined) continue;
    const method = (leaf.request.method ?? "GET").toLowerCase();
    const url = lowerUrl(leaf.request.url, variables);
    if (!servers.includes(url.base)) servers.push(url.base);

    // Dotted folder-path id, dropping generic prefixes and keeping at most 2 meaningful
    // folders + request name; collision handling is within buildOperationId.
    const id = buildOperationId(leaf.folders, leaf.item.name ?? "request", usedIds);
    usedIds.add(id);

    const { params, disabledQueryCount } = lowerParameters(url, headerList(leaf.request.header));

    // Build operation description, adding a summary sentence if query parameters are disabled.
    let operationDesc = descriptionText(leaf.request.description);
    if (disabledQueryCount > 0) {
      const totalQueryParams = url.query.filter((q) => q.key).length;
      const disabledSentence = `${disabledQueryCount} of ${totalQueryParams} documented query parameters are disabled in the source collection.`;
      operationDesc = operationDesc ? `${operationDesc}\n\n${disabledSentence}` : disabledSentence;
    }

    const operation: Record<string, unknown> = {
      operationId: id,
      summary: leaf.item.name,
      ...(operationDesc ? { description: operationDesc } : {}),
      ...(leaf.folders.length > 0 ? { tags: [...new Set(leaf.folders)] } : {}),
      parameters: params,
      responses: lowerResponses(leaf.item.response),
    };

    // A GET/HEAD body is un-executable by fetch — never emitted (the saved
    // request often carries an empty `raw` stub there anyway).
    if (method !== "get" && method !== "head") {
      const body = lowerBody(leaf.request.body);
      if (body) operation.requestBody = body;
    }

    // Request-level auth overrides the collection default; an explicit
    // `noauth` clears it (OpenAPI: `security: []`).
    if (leaf.request.auth?.type === "noauth") {
      operation.security = [];
    } else {
      const scheme = registerAuth(leaf.request.auth);
      if (scheme) operation.security = [{ [scheme]: [] }];
    }

    // First operation per (path, method) wins — the internal model is
    // path-keyed and OpenAPI cannot hold two. That is a real limitation, and it
    // used to be a SILENT one: a collection whose requests share an endpoint and
    // differ only by a query selector (an RPC-over-HTTP API — Moodle's
    // `?wsfunction=`, a JSON-RPC gateway) collapsed to one operation and said
    // nothing, so 800 functions could compile to 1 with a clean exit code.
    // Anvil's whole claim is that a surface never quietly loses an operation, so
    // the collision is now reported with the request that lost and the one that
    // holds the slot.
    const pathItem = paths[url.path] ?? {};
    if (pathItem[method] === undefined) {
      pathItem[method] = operation;
      paths[url.path] = pathItem;
    } else {
      const holder = (pathItem[method] as { summary?: string; operationId?: string }) ?? {};
      diagnostics?.push({
        level: "warning",
        code: "postman_endpoint_collision",
        path: `${method.toUpperCase()} ${url.path}`,
        message:
          `Postman request ${JSON.stringify(leaf.item.name ?? id)} was dropped: ` +
          `${method.toUpperCase()} ${url.path} is already taken by ` +
          `${JSON.stringify(holder.summary ?? holder.operationId ?? "an earlier request")}. ` +
          "Anvil keys operations by path and method, so requests that differ only by a " +
          "query selector or body cannot both be represented. Give each one a distinct " +
          "path (a gateway rewrite, or the synthetic per-operation paths Anvil already " +
          "uses for SOAP) and re-import.",
      });
    }
  }

  const scripts = countScripts(collection);
  const baseDescription = descriptionText(collection.info?.description);
  const scriptsNote =
    scripts > 0
      ? `Note: ${scripts} Postman script block(s) (pre-request/test JavaScript) were not translated; ` +
        "scripts often encode auth flows or request chaining — review the source collection if requests fail."
      : undefined;
  const description = [baseDescription, scriptsNote].filter(Boolean).join("\n\n") || undefined;

  const rawVersion = collection.info?.version;
  const version =
    typeof rawVersion === "string"
      ? rawVersion
      : rawVersion && typeof rawVersion === "object"
        ? `${rawVersion.major ?? 1}.${rawVersion.minor ?? 0}.${rawVersion.patch ?? 0}`
        : "1.0.0";

  return {
    openapi: "3.0.0",
    info: {
      title: collection.info?.name ?? "Postman Collection",
      version,
      ...(description ? { description } : {}),
    },
    ...(scripts > 0 ? { "x-anvil-postman-scripts": scripts } : {}),
    servers: (servers.length > 0 ? servers : ["https://example.invalid"]).map((u) => ({ url: u })),
    paths,
    components: {
      schemas: {},
      ...(Object.keys(securitySchemes).length > 0 ? { securitySchemes } : {}),
    },
    ...(collectionScheme ? { security: [{ [collectionScheme]: [] }] } : {}),
  } as OpenApiDocument;
}
