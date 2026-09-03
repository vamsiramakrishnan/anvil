/**
 * HAR (HTTP Archive, 1.2) → OpenAPI 3.0 adapter. A HAR capture (a browser's
 * "Save all as HAR", a proxy log, `mitmproxy`/Charles/Fiddler export) is
 * recorded TRAFFIC, not a contract: nobody declared what these endpoints mean,
 * only what actually crossed the wire. Every fact this adapter emits is
 * therefore an OBSERVATION — this file lowers the capture into the same
 * pre-dereference OpenAPI 3.0 shape every other adapter produces, and
 * `har-posture.ts` (driven from `compile.ts`) is what keeps the compiled
 * result honest about that: every operation lands at most `review_required`,
 * every safety-relevant claim is capped at low confidence, and a review note
 * says how many captured requests it came from. This file's job is only the
 * lowering; it asserts no safety semantic of its own.
 *
 * Detection: JSON carrying `log.version` (a string) and `log.entries` (an
 * array) — the HAR 1.2 envelope (`isHarCapture` in `protocols/index.ts`).
 *
 * Lowering rules (deterministic — same input, same output):
 *
 *   Grouping — entries are grouped by METHOD + a TEMPLATED path. A segment is
 *   templated (becomes `{name}`) when it is purely numeric, UUID-shaped, or
 *   otherwise contains a digit (`isTemplatable`) — the shape realistic ids
 *   take (Stripe-style `cus_101`, order refs, zero-padded numbers, UUIDs),
 *   decided from ONE sample already, exactly like the numeric/UUID case: a
 *   digit in a path segment is already strong evidence it is data, not a
 *   resource name. A purely alphabetic segment is NEVER templated on
 *   cross-entry variation alone, even when two samples disagree at that
 *   position (`/customers/123` next to `/payments/456` differ only at
 *   position 0 once position 1 is templated by the numeric rule — merging on
 *   "this position varies" with no other signal would fold two unrelated
 *   resources into one operation with no way to tell them apart from the
 *   varying value's shape). That is a deliberate, conservative boundary, the
 *   same one `path-grammar.ts` draws with its abstention band: decline to
 *   guess rather than assert a merge nothing in the evidence can defend.
 *   Every templated segment is named from the PRECEDING literal segment's
 *   singular (`singularize` from `naming.ts` — never re-implemented here):
 *   `/customers/123` → `/customers/{customer_id}`. A templated segment with no
 *   preceding literal (or two templated segments back to back) falls back to
 *   `id`, de-duplicated per path.
 *
 *   Servers — the distinct `scheme://host[:port]` origins observed, in
 *   first-appearance order (document-level `servers`, matching every other
 *   adapter).
 *
 *   Query parameters — the union of observed (non-secret) query key names;
 *   required iff the key is present in EVERY sample mapped to the operation,
 *   optional otherwise. Same required-iff-universal rule for header
 *   parameters. Path parameters are always required (structural).
 *
 *   Request/response bodies — JSON bodies are schema-inferred CONSERVATIVELY
 *   across every sample mapped to the operation (`inferUnionSchema`): a
 *   property's type is the union of types observed for it, `required` lists
 *   only properties present in every sample that has a body at all, and
 *   `additionalProperties: true` always — an observed shape is a lower bound,
 *   never a closed contract. Response entries are keyed by observed status
 *   code.
 *
 *   `x-anvil-observed` — every operation carries
 *   `{ samples, firstSeen, lastSeen }` (from `entry.startedDateTime`) so
 *   `har-posture.ts` can cite exactly how many captured requests backed it.
 *
 *   `operationId` — deliberately NEVER set. HAR has no concept of one, and
 *   inventing one (the way `postman.ts` mints a folder-path id) would be a
 *   fabricated fact dressed as a declared one. Leaving it unset routes every
 *   operation through the compiler's own path+method naming heuristic — the
 *   same fallback an OpenAPI document with no `operationId` already gets.
 *
 *   Secrets — dropped BEFORE anything else in this file touches an entry
 *   (`dropSecrets`, called first in `adaptHar`): `Authorization`, `Cookie`,
 *   `Set-Cookie`, `Proxy-Authorization`, and any header/query name matching
 *   `/token|secret|key|password|session/i`. Their VALUES are never read for
 *   any purpose other than the single allowed exception below — never copied
 *   into a schema, a diagnostic, an example, or a parameter — and the header
 *   itself never becomes a regular parameter. The one narrow exception:
 *   `Authorization`'s value is inspected ONLY to read its leading scheme
 *   word (`Bearer` / `Basic`) — never the credential that follows — so the
 *   operation can record which auth SCHEME was used without ever touching the
 *   material that makes it work. One `har_secrets_dropped` diagnostic reports
 *   the count. A carrier's NAME (e.g. the string `"X-Api-Key"`) is not secret
 *   material and is kept — it is what `auth.provider.apiKey.name` needs to be
 *   useful, the same allowance `postman.ts` makes for its `AUTH_PARAM_ALLOWLIST`.
 *   This scrubbing covers headers and query parameters, the carriers named in
 *   the spec this adapter implements; a request/response BODY field that
 *   happens to be named `password` is documented like any other observed
 *   field (mirroring Postman's "body examples ARE copied" policy) — capture
 *   tooling that redacts body secrets before handing Anvil the file remains
 *   the operator's responsibility, exactly as it is before handing anyone a
 *   HAR file at all.
 */
import type { Diagnostic } from "@anvil/air";
import { singularize } from "../naming.js";
import type { OpenApiDocument } from "../parse.js";

/* ----------------------------- source shapes ----------------------------- */

interface HarNameValue {
  name?: string;
  value?: string;
}

interface HarPostData {
  mimeType?: string;
  text?: string;
}

interface HarRequest {
  method?: string;
  url?: string;
  headers?: HarNameValue[];
  queryString?: HarNameValue[];
  postData?: HarPostData;
}

interface HarContent {
  mimeType?: string;
  text?: string;
}

interface HarResponse {
  status?: number;
  content?: HarContent;
}

interface HarEntry {
  startedDateTime?: string;
  request?: HarRequest;
  response?: HarResponse;
}

interface HarLog {
  version?: string;
  entries?: HarEntry[];
}

interface HarFile {
  log?: HarLog;
}

/* ------------------------------- detection -------------------------------- */

/** Recognize a HAR 1.2 capture: `log.version` (string) + `log.entries` (array). */
export function isHarCapture(text: string): boolean {
  if (!text.includes('"log"') || !text.includes('"entries"')) return false;
  try {
    const doc = JSON.parse(text) as HarFile;
    return typeof doc.log?.version === "string" && Array.isArray(doc.log.entries);
  } catch {
    return false;
  }
}

/** The capture's declared HAR version, or "1.2" (the spec's own version) when absent. */
export function harVersion(text: string): string {
  try {
    const doc = JSON.parse(text) as HarFile;
    return typeof doc.log?.version === "string" && doc.log.version.trim() !== ""
      ? doc.log.version
      : "1.2";
  } catch {
    return "1.2";
  }
}

/* --------------------------------- secrets --------------------------------- */

const SECRET_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
]);
const SECRET_NAME_PATTERN = /token|secret|key|password|session/i;

function isSecretHeader(name: string): boolean {
  return SECRET_HEADER_NAMES.has(name.toLowerCase()) || SECRET_NAME_PATTERN.test(name);
}

function isSecretQuery(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

/** Runtime-owned headers: normalize drops these as inputs regardless (finding #33). */
const RUNTIME_HEADERS = new Set(["content-type", "accept"]);

/**
 * The only thing this adapter ever reads out of `Authorization`'s value: its
 * leading scheme word, and ONLY when that word is a recognized one
 * (`Bearer`/`Basic`) — a value with no recognized word (a bare opaque token,
 * with nothing before the credential to strip) is classified `"(present)"`
 * without ever touching a byte of it. Nothing past the first space, and
 * nothing at all for an unrecognized shape, is ever read, stored, or
 * returned.
 */
function classifyAuthorizationValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const spaceIndex = trimmed.indexOf(" ");
  const word = spaceIndex >= 0 ? trimmed.slice(0, spaceIndex).toLowerCase() : "";
  if (word === "bearer") return "Bearer";
  if (word === "basic") return "Basic";
  return "(present)";
}

/**
 * Sanitized clone of one entry's request — called first, before any other
 * function in this file sees the entry. Every secret header/query keeps its
 * NAME (never secret material; it is what `auth.provider.apiKey.name` needs)
 * but loses its VALUE outright, with one narrow exception:
 * `Authorization`'s value is replaced by `classifyAuthorizationValue`'s
 * verdict — `"Bearer"`, `"Basic"`, or `"(present)"` — never the credential
 * itself. Returns the clone plus how many header/query values were dropped,
 * for the aggregate `har_secrets_dropped` diagnostic. Every later function in
 * this file (parameter building, auth-scheme derivation) reads ONLY this
 * sanitized clone, never the original entries — so there is no code path
 * left that could reach a secret value even by accident. No downstream
 * function ever serializes a header/query VALUE (secret or not) into the
 * lowered document — parameters carry only name/location/schema — so this
 * function's own output is exported and tested directly rather than only
 * through `adaptHar`'s document: a document-level assertion could never
 * observe this scrub either way, secrets or none.
 */
export function dropSecrets(entries: HarEntry[]): { entries: HarEntry[]; dropped: number } {
  let dropped = 0;
  const cleaned = entries.map((entry) => {
    const headers = (entry.request?.headers ?? []).map((h): HarNameValue => {
      if (!h.name) return h;
      if (h.name.toLowerCase() === "authorization") {
        if (h.value !== undefined) dropped += 1;
        const verdict = classifyAuthorizationValue(h.value);
        return verdict !== undefined ? { name: h.name, value: verdict } : { name: h.name };
      }
      if (isSecretHeader(h.name)) {
        if (h.value !== undefined) dropped += 1;
        return { name: h.name };
      }
      return h;
    });
    const queryString = (entry.request?.queryString ?? []).map((q): HarNameValue => {
      if (!q.name) return q;
      if (isSecretQuery(q.name)) {
        if (q.value !== undefined) dropped += 1;
        return { name: q.name };
      }
      return q;
    });
    return {
      ...entry,
      request: entry.request ? { ...entry.request, headers, queryString } : entry.request,
    };
  });
  return { entries: cleaned, dropped };
}

/* ----------------------------- path templating ------------------------------ */

function isNumericSegment(seg: string): boolean {
  return /^[0-9]+$/.test(seg);
}
function isUuidSegment(seg: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg);
}
/**
 * A path segment is templatable — decided from ONE sample, no cross-entry
 * evidence needed — when it is purely numeric, UUID-shaped, or otherwise
 * contains a digit. See the file header for why a digit is the bar rather
 * than "this position varies across samples": the latter cannot tell a real
 * id apart from two genuinely different resources sharing a segment count.
 */
function isTemplatable(seg: string): boolean {
  return isNumericSegment(seg) || isUuidSegment(seg) || /[0-9]/.test(seg);
}

interface ParsedEntry {
  entry: HarEntry;
  method: string;
  origin?: string;
  segments: string[];
}

/** Parse `request.url` once per entry; malformed URLs are reported and skipped. */
function parseEntries(entries: HarEntry[], diagnostics: Diagnostic[] | undefined): ParsedEntry[] {
  const parsed: ParsedEntry[] = [];
  entries.forEach((entry, index) => {
    const method = (entry.request?.method ?? "GET").toLowerCase();
    const raw = entry.request?.url;
    if (!raw) {
      diagnostics?.push({
        level: "warning",
        code: "har_entry_unparseable_url",
        path: `entries[${index}]`,
        message: "HAR entry has no request.url; skipped.",
      });
      return;
    }
    try {
      const u = new URL(raw);
      const segments = u.pathname.split("/").filter((s) => s !== "");
      parsed.push({ entry, method, origin: u.origin, segments });
    } catch {
      diagnostics?.push({
        level: "warning",
        code: "har_entry_unparseable_url",
        path: `entries[${index}]`,
        message: `HAR entry's request.url is not a parseable absolute URL: ${JSON.stringify(raw)}. Skipped.`,
      });
    }
  });
  return parsed;
}

interface TemplatedGroup {
  method: string;
  template: string;
  paramNames: string[];
  templatedPositions: Set<number>;
  entries: HarEntry[];
}

/** Name a templated segment at `index` from the nearest preceding LITERAL segment. */
function paramNameFor(
  finalSegments: string[],
  templatedPositions: Set<number>,
  index: number,
  used: Set<string>,
): string {
  let base: string | undefined;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (!templatedPositions.has(i)) {
      base = singularize(finalSegments[i] as string)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_");
      break;
    }
  }
  const root = base && base !== "" ? `${base}_id` : "id";
  let name = root;
  for (let n = 2; used.has(name); n += 1) name = `${root}_${n}`;
  used.add(name);
  return name;
}

/**
 * Group parsed entries into templated (method, path) operations — the
 * per-segment rule documented in the file header and on `isTemplatable`.
 */
function templateGroups(parsed: ParsedEntry[]): TemplatedGroup[] {
  // Each entry's skeleton IS its final group key: isTemplatable is decided
  // per segment from that one entry (no cross-entry evidence needed), so
  // entries land together iff they already agree on every literal segment.
  const buckets = new Map<string, ParsedEntry[]>();
  for (const p of parsed) {
    const skeleton = p.segments.map((s) => (isTemplatable(s) ? " " : s));
    const key = `${p.method} /${skeleton.join("/")}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(p);
    buckets.set(key, bucket);
  }

  const groups: TemplatedGroup[] = [];
  for (const group of buckets.values()) {
    const first = group[0];
    if (!first) continue;
    const method = first.method;
    const finalSegments = first.segments;
    const templatedPositions = new Set<number>();
    finalSegments.forEach((seg, i) => {
      if (isTemplatable(seg)) templatedPositions.add(i);
    });
    const used = new Set<string>();
    const paramNames: string[] = [];
    const rendered = finalSegments.map((seg, i) => {
      if (!templatedPositions.has(i)) return seg;
      const name = paramNameFor(finalSegments, templatedPositions, i, used);
      paramNames.push(name);
      return `{${name}}`;
    });
    groups.push({
      method,
      template: `/${rendered.join("/")}`,
      paramNames,
      templatedPositions,
      entries: group.map((p) => p.entry),
    });
  }
  // Deterministic order: method, then template, so the compiled document (and
  // every fixture/golden diffed against it) is stable across runs.
  groups.sort((a, b) => a.method.localeCompare(b.method) || a.template.localeCompare(b.template));
  return groups;
}

/* ---------------------------- schema inference ---------------------------- */

/** JSON-parse a response/request body; undefined when absent or unparseable. */
function tryParseJson(mimeType: string | undefined, text: string | undefined): unknown {
  if (!text || text.trim() === "") return undefined;
  if (mimeType && !/json/i.test(mimeType)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

type Json = unknown;

/** JSON Schema primitive `type` for one scalar value ("null" is handled by the caller). */
function scalarType(value: Json): string {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

/**
 * Infer a schema from every SAMPLE observed for one position — conservative by
 * construction: a property's type is the UNION of types seen for it across
 * samples, `required` lists only properties present in every sample that
 * carries an object at all, `additionalProperties: true` always (an observed
 * shape is a lower bound on the real one, never a closed contract), and a
 * mismatched kind (object in one sample, array in another) degrades to a
 * permissive `{}` rather than asserting either shape as authoritative.
 */
function inferUnionSchema(samples: Json[]): Record<string, unknown> {
  const present = samples.filter((s) => s !== undefined);
  if (present.length === 0) return {};

  const sawNull = present.some((s) => s === null);
  const nonNull: Json[] = present.filter((s) => s !== null);
  if (nonNull.length === 0) return { type: "string", nullable: true };

  const kinds = new Set(
    nonNull.map((s) => (Array.isArray(s) ? "array" : typeof s === "object" ? "object" : "scalar")),
  );
  if (kinds.size > 1) {
    // Heterogeneous across samples: honest silence beats a wrong guess.
    return sawNull ? { nullable: true } : {};
  }
  const kind = [...kinds][0];

  if (kind === "object") {
    const objects = nonNull as Record<string, unknown>[];
    const keys = new Set<string>();
    for (const o of objects) for (const k of Object.keys(o)) keys.add(k);
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const key of [...keys].sort()) {
      const present = objects.filter((o) => Object.hasOwn(o, key));
      properties[key] = inferUnionSchema(present.map((o) => o[key]));
      if (present.length === objects.length) required.push(key);
    }
    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: true,
      ...(sawNull ? { nullable: true } : {}),
    };
  }

  if (kind === "array") {
    const items = (nonNull as unknown[][]).flat();
    return {
      type: "array",
      items: items.length > 0 ? inferUnionSchema(items) : {},
      ...(sawNull ? { nullable: true } : {}),
    };
  }

  const scalarKinds = new Set(nonNull.map(scalarType));
  const type = scalarKinds.size === 1 ? [...scalarKinds][0] : [...scalarKinds].sort();
  return {
    ...(Array.isArray(type) ? { type } : { type }),
    ...(sawNull ? { nullable: true } : {}),
  };
}

/* --------------------------------- auth ---------------------------------- */

interface AuthSignal {
  /** Stable identity for dedup at the document level. */
  id: string;
  name: string;
  scheme: Record<string, unknown>;
}

/** Sanitize a header/query name into a valid OpenAPI component-name fragment. */
function sanitizeSchemeFragment(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "carrier";
}

/**
 * The single auth signal for one operation's entries, by priority: an
 * explicit api-key-shaped carrier (a header/query NAME matching the secret
 * pattern — never its value) outranks a recognized `Authorization` scheme
 * word, which outranks an unrecognized one. HAR entries for one operation
 * essentially never show two credential TYPES at once; picking the most
 * specific single signal keeps the compiled auth model resolvable (a
 * composite AND of two schemes would block the operation on
 * `auth/composite_unmodeled` for a distinction the capture cannot actually
 * prove).
 */
function deriveAuthSignal(entries: HarEntry[]): AuthSignal | undefined {
  const apiKeyCarriers = new Map<string, { in: "header" | "query"; name: string }>();
  let bearer = false;
  let basic = false;
  let otherAuthHeader = false;

  // `entries` MUST be the sanitized clone `dropSecrets` produced: this reads
  // `h.value` for `Authorization`, and only `dropSecrets`'s classified verdict
  // (`"Bearer"` / `"Basic"` / `"(present)"`) ever makes it that far.
  for (const entry of entries) {
    for (const h of entry.request?.headers ?? []) {
      if (!h.name) continue;
      if (h.name.toLowerCase() === "authorization") {
        if (h.value === "Bearer") bearer = true;
        else if (h.value === "Basic") basic = true;
        else if (h.value === "(present)") otherAuthHeader = true;
        continue;
      }
      if (SECRET_NAME_PATTERN.test(h.name)) {
        apiKeyCarriers.set(`header:${h.name}`, { in: "header", name: h.name });
      }
    }
    for (const q of entry.request?.queryString ?? []) {
      if (q.name && SECRET_NAME_PATTERN.test(q.name)) {
        apiKeyCarriers.set(`query:${q.name}`, { in: "query", name: q.name });
      }
    }
  }

  if (apiKeyCarriers.size > 0) {
    // Deterministic pick: sort by identity, take the first.
    const [carrier] = [...apiKeyCarriers.values()].sort((a, b) =>
      `${a.in}:${a.name}`.localeCompare(`${b.in}:${b.name}`),
    );
    const c = carrier as { in: "header" | "query"; name: string };
    const frag = sanitizeSchemeFragment(c.name);
    return {
      id: `apikey:${c.in}:${c.name}`,
      name: `apiKeyAuth_${frag}`,
      scheme: { type: "apiKey", in: c.in, name: c.name },
    };
  }
  if (bearer) {
    return { id: "bearer", name: "bearerAuth", scheme: { type: "http", scheme: "bearer" } };
  }
  if (basic) {
    return { id: "basic", name: "basicAuth", scheme: { type: "http", scheme: "basic" } };
  }
  if (otherAuthHeader) {
    return {
      id: "authHeader",
      name: "authHeaderAuth",
      scheme: { type: "apiKey", in: "header", name: "Authorization" },
    };
  }
  return undefined;
}

/* --------------------------------- adapter --------------------------------- */

/**
 * Lower a HAR 1.2 capture. `diagnostics` receives `har_secrets_dropped`
 * (always, so a capture with nothing to drop still confirms the scrub ran)
 * and `har_entry_unparseable_url` for any entry this adapter had to skip.
 */
export function adaptHar(
  text: string,
  title?: string,
  diagnostics?: Diagnostic[],
): OpenApiDocument {
  let har: HarFile;
  try {
    har = JSON.parse(text) as HarFile;
  } catch (err) {
    throw new Error(`Invalid HAR JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (typeof har.log?.version !== "string" || !Array.isArray(har.log.entries)) {
    throw new Error("Not a HAR 1.2 capture: log.version/log.entries are missing.");
  }

  const { entries: sanitized, dropped } = dropSecrets(har.log.entries);
  diagnostics?.push({
    level: "info",
    code: "har_secrets_dropped",
    message:
      `${dropped} secret header/query value(s) (Authorization, Cookie, Set-Cookie, ` +
      "Proxy-Authorization, and any name matching /token|secret|key|password|session/i) were " +
      "dropped before this capture was lowered; none were copied into the compiled document.",
  });

  const parsed = parseEntries(sanitized, diagnostics);
  const groups = templateGroups(parsed);

  const servers: string[] = [];
  for (const p of parsed) {
    if (p.origin && !servers.includes(p.origin)) servers.push(p.origin);
  }

  const securitySchemes: Record<string, unknown> = {};
  const paths: Record<string, Record<string, unknown>> = {};

  for (const group of groups) {
    const params: Record<string, unknown>[] = [];

    for (const name of group.paramNames) {
      params.push({ name, in: "path", required: true, schema: { type: "string" } });
    }

    const queryKeys = new Map<string, number>();
    const headerKeys = new Map<string, number>();
    for (const entry of group.entries) {
      const seenQuery = new Set<string>();
      for (const q of entry.request?.queryString ?? []) {
        // A secret query carrier is represented ONLY via `auth`, never also
        // as a regular string parameter — its value was never usable anyway.
        if (!q.name || isSecretQuery(q.name) || seenQuery.has(q.name)) continue;
        seenQuery.add(q.name);
        queryKeys.set(q.name, (queryKeys.get(q.name) ?? 0) + 1);
      }
      const seenHeader = new Set<string>();
      for (const h of entry.request?.headers ?? []) {
        if (!h.name) continue;
        const lower = h.name.toLowerCase();
        // Same exclusion as query above, plus the runtime-owned headers
        // normalize drops as inputs regardless (finding #33).
        if (RUNTIME_HEADERS.has(lower) || isSecretHeader(h.name) || seenHeader.has(lower)) continue;
        seenHeader.add(lower);
        headerKeys.set(h.name, (headerKeys.get(h.name) ?? 0) + 1);
      }
    }
    const total = group.entries.length;
    for (const [name, count] of [...queryKeys.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      params.push({
        name,
        in: "query",
        required: count === total,
        schema: { type: "string" },
      });
    }
    for (const [name, count] of [...headerKeys.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      params.push({
        name,
        in: "header",
        required: count === total,
        schema: { type: "string" },
      });
    }

    const method = group.method;
    const operation: Record<string, unknown> = {
      summary: `${method.toUpperCase()} ${group.template}`,
      description: `Observed via captured traffic (${total} sample${total === 1 ? "" : "s"}).`,
      parameters: params,
    };

    if (method !== "get" && method !== "head") {
      const bodies = group.entries
        .map((e) => tryParseJson(e.request?.postData?.mimeType, e.request?.postData?.text))
        .filter((v) => v !== undefined);
      if (bodies.length > 0) {
        operation.requestBody = {
          content: { "application/json": { schema: inferUnionSchema(bodies) } },
        };
      }
    }

    const byStatus = new Map<string, Json[]>();
    for (const entry of group.entries) {
      const status =
        typeof entry.response?.status === "number" && entry.response.status >= 100
          ? String(entry.response.status)
          : "200";
      const body = tryParseJson(entry.response?.content?.mimeType, entry.response?.content?.text);
      const list = byStatus.get(status) ?? [];
      list.push(body);
      byStatus.set(status, list);
    }
    const responses: Record<string, unknown> = {};
    if (byStatus.size === 0) {
      responses["200"] = { description: "Observed response." };
    } else {
      for (const [status, bodies] of [...byStatus.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const present = bodies.filter((b) => b !== undefined);
        responses[status] =
          present.length > 0
            ? {
                description: `Observed response (${bodies.length} sample${bodies.length === 1 ? "" : "s"}).`,
                content: { "application/json": { schema: inferUnionSchema(present) } },
              }
            : {
                description: `Observed response (${bodies.length} sample${bodies.length === 1 ? "" : "s"}).`,
              };
      }
    }
    operation.responses = responses;

    const auth = deriveAuthSignal(group.entries);
    if (auth) {
      if (securitySchemes[auth.name] === undefined) securitySchemes[auth.name] = auth.scheme;
      operation.security = [{ [auth.name]: [] }];
    }

    const firstSeen = group.entries
      .map((e) => e.startedDateTime)
      .filter((t): t is string => Boolean(t))
      .sort()[0];
    const lastSeen = group.entries
      .map((e) => e.startedDateTime)
      .filter((t): t is string => Boolean(t))
      .sort()
      .at(-1);
    operation["x-anvil-observed"] = {
      samples: total,
      ...(firstSeen ? { firstSeen } : {}),
      ...(lastSeen ? { lastSeen } : {}),
    };

    const pathItem = paths[group.template] ?? {};
    if (pathItem[method] === undefined) {
      pathItem[method] = operation;
      paths[group.template] = pathItem;
    } else {
      diagnostics?.push({
        level: "warning",
        code: "har_endpoint_collision",
        path: `${method.toUpperCase()} ${group.template}`,
        message:
          `Two distinct path-templating groups both resolved to ${method.toUpperCase()} ` +
          `${group.template}; the later group's ${total} sample(s) were dropped. Anvil keys ` +
          "operations by path and method, so requests that template to the same coordinate " +
          "cannot both be represented.",
      });
    }
  }

  return {
    openapi: "3.0.0",
    info: {
      title: title ?? "Captured Traffic",
      version: harVersion(text),
      description:
        `Compiled from a HAR ${harVersion(text)} capture (${sanitized.length} request(s) observed). ` +
        "Every operation here is an OBSERVATION, not a specification — see docs/SOURCE_FORMATS.md#captured-traffic-har.",
    },
    servers: (servers.length > 0 ? servers : ["https://example.invalid"]).map((u) => ({ url: u })),
    paths,
    components: {
      schemas: {},
      ...(Object.keys(securitySchemes).length > 0 ? { securitySchemes } : {}),
    },
  } as OpenApiDocument;
}
