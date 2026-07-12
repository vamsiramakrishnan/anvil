import { type AirDocument, type JsonSchema, type Operation, propKey } from "@anvil/air";

/**
 * Mock generation with provenance (spec: "Mock generation"). Mocks are not
 * random JSON; each scenario records where its payload came from. Here we
 * synthesize from the output schema and documented error responses, which is
 * the lowest-priority-but-always-available source; richer sources (recorded
 * traffic, examples, Postman) are layered in by the harness loop.
 */
export interface MockScenario {
  name: string;
  operationId: string;
  /** Wire coordinates of the operation this scenario answers for. */
  method?: string;
  path?: string;
  status: number;
  provenance: "schema_generated" | "example" | "synthetic";
  body: unknown;
}

export function generateScenarios(air: AirDocument): MockScenario[] {
  const scenarios: MockScenario[] = [];
  for (const op of air.operations) {
    if (op.state !== "approved") continue;
    scenarios.push({
      name: `${op.canonicalName}_success`,
      operationId: op.id,
      method: (op.sourceRef.method ?? "get").toUpperCase(),
      path: op.sourceRef.path ?? "/",
      status: op.effect.kind === "mutation" ? 201 : 200,
      provenance: "schema_generated",
      body: exampleFromSchema(op.output.schema),
    });
    for (const err of op.errors) {
      const status = err.upstream?.httpStatus;
      if (!status || status < 400) continue;
      scenarios.push({
        name: `${op.canonicalName}_${err.code}`,
        operationId: op.id,
        method: (op.sourceRef.method ?? "get").toUpperCase(),
        path: op.sourceRef.path ?? "/",
        status,
        provenance: "synthetic",
        body: { error: { code: err.code, message: err.message ?? err.code } },
      });
    }
  }
  return scenarios;
}

/**
 * Example input payload for an operation, for the skill's examples/ dir and the
 * loopback self-test. Keys are the *input surface* keys (`propKey`, matching the
 * generated CLI/MCP input schema), not the raw wire names — camelCase spec names
 * surface as snake_case inputs, and an example an agent cannot paste back into
 * the tool would be a lie.
 */
export function exampleInput(op: Operation): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of op.input.params) {
    out[propKey(p.name)] = p.example ?? exampleFromSchema(p.schema);
  }
  const body = op.input.body;
  if (body?.projection === "fields") {
    for (const f of body.fields) out[propKey(f.name)] = exampleFromSchema(f.schema);
  } else if (body) {
    out.body = exampleFromSchema(body.schema);
  }
  if (op.idempotency.mode === "required") out.idempotency_key = `${op.canonicalName}-example-key`;
  if (op.confirmation.required) out.confirm = true;
  return out;
}

/** Cap on nested object/array depth for a synthesized example (defense in depth —
 * memoization below already makes a shared subschema O(1) on repeat visits, but a
 * long *unshared* chain should still terminate quickly rather than build a huge
 * example nobody reads). */
const MAX_EXAMPLE_DEPTH = 8;

/**
 * Best-effort example value from a JSON schema. Memoized by schema object
 * identity: a heavily cross-referential real spec (Stripe's ~860 schemas, each
 * commonly reachable from dozens of operations) reaches the same nested schema
 * object from many call sites, and without this cache each occurrence
 * recomputed its whole example subtree from scratch — bundle generation for
 * such a spec effectively hung. `parse.ts`'s `decycleDocument` already gives
 * repeated references to the same subschema a stable, shared object identity,
 * which is exactly what this cache keys off.
 */
export function exampleFromSchema(
  schema: JsonSchema | undefined,
  cache: Map<JsonSchema, unknown> = new Map(),
  depth = 0,
): unknown {
  if (!schema) return null;
  const cached = cache.get(schema);
  if (cached !== undefined) return cached;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (depth >= MAX_EXAMPLE_DEPTH) return schema.type === "array" ? [] : {};
  switch (schema.type) {
    case "string":
      return typeof schema.format === "string" && schema.format.includes("date")
        ? "2026-07-09T00:00:00Z"
        : "example";
    case "integer":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "number":
      return 1.0;
    case "boolean":
      return true;
    case "array":
      return [exampleFromSchema(schema.items as JsonSchema | undefined, cache, depth + 1)];
    case "object": {
      const props = (schema.properties as Record<string, JsonSchema>) ?? {};
      const obj: Record<string, unknown> = {};
      cache.set(schema, obj); // set before recursing so a cycle in unshared data still terminates
      for (const [k, v] of Object.entries(props)) obj[k] = exampleFromSchema(v, cache, depth + 1);
      return obj;
    }
    default:
      return null;
  }
}

/**
 * One entry of the mock's routing table: the wire contract of an approved
 * operation, projected from AIR at build time so the emitted server can route
 * and validate without parsing AIR itself. Written to `mock/routes.json`.
 */
export interface MockRoute {
  operationId: string;
  canonicalName: string;
  method: string;
  /** REST path template, e.g. /payments/{payment_id}/refunds. */
  path: string;
  pathParams: string[];
  queryParams: string[];
  requiredQuery: string[];
  headerParams: string[];
  /** The request-body contract, when the operation expects one. */
  body?: { required: boolean; contentType: string; requiredFields: string[] };
  /** The per-operation input schema shipped in the bundle, for reference. */
  schemaRef: string;
}

export function generateMockRoutes(air: AirDocument): MockRoute[] {
  const routes: MockRoute[] = [];
  for (const op of air.operations) {
    if (op.state !== "approved") continue;
    const byIn = (where: string) => op.input.params.filter((p) => p.in === where);
    const route: MockRoute = {
      operationId: op.id,
      canonicalName: op.canonicalName,
      method: (op.sourceRef.method ?? "get").toUpperCase(),
      path: op.sourceRef.path ?? "/",
      pathParams: byIn("path").map((p) => p.name),
      queryParams: byIn("query").map((p) => p.name),
      requiredQuery: byIn("query")
        .filter((p) => p.required)
        .map((p) => p.name),
      headerParams: byIn("header").map((p) => p.name),
      schemaRef: `schemas/${op.id}.schema.json`,
    };
    const body = op.input.body;
    // Legacy AIR still carries body fields as in:"body" params — honor them so
    // an old bundle's mock validates the same body the executor sends.
    const legacyBody = byIn("body");
    if (body) {
      route.body = {
        required: body.required,
        contentType: body.contentType,
        requiredFields:
          body.projection === "fields"
            ? body.fields.filter((f) => f.required).map((f) => f.name)
            : ((body.schema.required as string[] | undefined) ?? []),
      };
    } else if (legacyBody.length > 0) {
      route.body = {
        required: legacyBody.some((p) => p.required),
        contentType: "application/json",
        requiredFields: legacyBody.filter((p) => p.required).map((p) => p.name),
      };
    }
    routes.push(route);
  }
  return routes;
}

export function generateMockServerSource(air: AirDocument): string {
  return `#!/usr/bin/env node
// Generated mock server for "${air.service.id}". Routes each request against
// the AIR-derived table in routes.json, validates it against the operation's
// input contract, and replays recorded scenarios — so the generated MCP/CLI
// path can be proven end-to-end without the real upstream. Control endpoints
// live under the reserved /__anvil/ prefix (capture, reset, scenario, fault).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scenarios = JSON.parse(
  readFileSync(fileURLToPath(new URL("./scenarios.json", import.meta.url)), "utf8"),
);
const routes = JSON.parse(
  readFileSync(fileURLToPath(new URL("./routes.json", import.meta.url)), "utf8"),
);

// Auth material must never be stored, even by a mock (safety contract §18).
const REDACT = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key"]);
const redactHeaders = (raw) => {
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = REDACT.has(k.toLowerCase()) ? "***" : v;
  return out;
};

// Mutable mock state, all resettable via POST /__anvil/reset.
const CAPTURE_LIMIT = 500;
let captures = [];
let scenarioOverride = process.env.ANVIL_MOCK_SCENARIO ?? null;
let faults = new Map(); // operationId -> { status, times }

/** Match a path template against a concrete path; {params} match any non-empty segment. */
function matchPath(template, path) {
  const t = template.split("/").filter(Boolean);
  const p = path.split("/").filter(Boolean);
  if (t.length !== p.length) return null;
  const params = {};
  for (let i = 0; i < t.length; i++) {
    const m = /^\\{(.+)\\}$/.exec(t[i]);
    if (m) params[m[1]] = decodeURIComponent(p[i]);
    else if (t[i] !== p[i]) return null;
  }
  return params;
}

/** Rough similarity for 404 hints: shared leading path segments, then method. */
function nearest(method, path) {
  const segs = path.split("/").filter(Boolean);
  const score = (r) => {
    const t = r.path.split("/").filter(Boolean);
    let shared = 0;
    while (shared < Math.min(t.length, segs.length) && (t[shared] === segs[shared] || t[shared].startsWith("{"))) shared++;
    return shared * 2 + (r.method === method.toUpperCase() ? 1 : 0);
  };
  return [...routes]
    .sort((a, b) => score(b) - score(a))
    .slice(0, 3)
    .map((r) => ({ operationId: r.operationId, method: r.method, path: r.path }));
}

/** Validate a matched request against the operation's input contract. */
function validate(route, query, body, bodyError) {
  const missing = [];
  const invalid = [];
  for (const q of route.requiredQuery) {
    if (!query.has(q)) missing.push(\`query.\${q}\`);
  }
  if (route.body) {
    if (bodyError) invalid.push(\`body: \${bodyError}\`);
    else if (body === undefined) {
      if (route.body.required) missing.push("body");
    } else if (typeof body !== "object" || body === null || Array.isArray(body)) {
      invalid.push("body: expected a JSON object");
    } else {
      for (const f of route.body.requiredFields) {
        if (body[f] === undefined || body[f] === null) missing.push(\`body.\${f}\`);
      }
    }
  } else if (body !== undefined) {
    invalid.push("body: this operation does not accept a request body");
  }
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}

function scenarioFor(route) {
  const forOp = scenarios.filter((s) => s.operationId === route.operationId);
  if (scenarioOverride) {
    const override = forOp.find((s) => s.name === scenarioOverride);
    if (override) return override;
  }
  return forOp.find((s) => s.name === \`\${route.canonicalName}_success\`) ?? forOp[0];
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function control(req, res, url, rawBody) {
  const parsed = rawBody ? JSON.parse(rawBody) : {};
  if (req.method === "GET" && url.pathname === "/__anvil/capture") {
    return json(res, 200, { requests: captures });
  }
  if (req.method === "POST" && url.pathname === "/__anvil/reset") {
    captures = [];
    faults = new Map();
    scenarioOverride = process.env.ANVIL_MOCK_SCENARIO ?? null;
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/__anvil/scenario") {
    if (parsed.name !== null && !scenarios.some((s) => s.name === parsed.name)) {
      return json(res, 400, { error: { code: "unknown_scenario", name: parsed.name } });
    }
    scenarioOverride = parsed.name;
    return json(res, 200, { ok: true, scenario: scenarioOverride });
  }
  if (req.method === "POST" && url.pathname === "/__anvil/fault") {
    if (!routes.some((r) => r.operationId === parsed.opId)) {
      return json(res, 400, { error: { code: "unknown_operation", opId: parsed.opId } });
    }
    faults.set(parsed.opId, { status: parsed.status ?? 503, times: parsed.times ?? 1 });
    return json(res, 200, { ok: true, opId: parsed.opId });
  }
  return json(res, 404, { error: { code: "unknown_control_endpoint", path: url.pathname } });
}

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://mock.local");
    const rawBody = Buffer.concat(chunks).toString("utf8");
    if (url.pathname.startsWith("/__anvil/")) {
      try {
        return control(req, res, url, rawBody);
      } catch (err) {
        return json(res, 400, { error: { code: "bad_control_request", message: String(err) } });
      }
    }

    // Route: method + template match. WSDL-lowered services may share one
    // path+POST, so ambiguity is legal — first match wins, all candidates are
    // recorded so a self-test can disambiguate by resetting capture per call.
    const candidates = routes.filter(
      (r) => r.method === (req.method ?? "GET").toUpperCase() && matchPath(r.path, url.pathname),
    );
    const route = candidates[0];

    let body;
    let bodyError;
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        bodyError = "request body is not valid JSON";
      }
    }
    const query = url.searchParams;
    const validation = route
      ? validate(route, query, body, bodyError)
      : { ok: false, missing: [], invalid: [] };

    const record = {
      ts: new Date().toISOString(),
      method: req.method ?? "GET",
      url: req.url ?? "/",
      path: url.pathname,
      query: Object.fromEntries(query.entries()),
      headers: redactHeaders(req.headers),
      contentType: req.headers["content-type"] ?? null,
      body: body ?? (rawBody.length > 0 ? rawBody : null),
      matchedOpId: route?.operationId ?? null,
      matchedCandidates: candidates.map((r) => r.operationId),
      pathParams: route ? matchPath(route.path, url.pathname) : null,
      validation,
      response: null,
    };
    captures.push(record);
    if (captures.length > CAPTURE_LIMIT) captures.shift();

    if (!route) {
      record.response = { status: 404, kind: "no_route" };
      return json(res, 404, {
        error: {
          code: "mock_no_route",
          message: \`No approved operation matches \${req.method} \${url.pathname}.\`,
          candidates: nearest(req.method ?? "GET", url.pathname),
        },
      });
    }

    // Injected faults take precedence: "the next N matched requests fail".
    const fault = faults.get(route.operationId);
    if (fault && fault.times > 0) {
      fault.times -= 1;
      record.response = { status: fault.status, kind: "fault" };
      return json(res, fault.status, {
        error: { code: "injected_fault", operation: route.operationId, status: fault.status },
      });
    }

    if (!validation.ok) {
      record.response = { status: 400, kind: "validation_error" };
      return json(res, 400, {
        error: {
          code: "mock_validation_failed",
          operation: route.operationId,
          missing: validation.missing,
          invalid: validation.invalid,
        },
      });
    }

    const pick = scenarioFor(route);
    record.response = { status: pick?.status ?? 200, kind: "scenario", scenario: pick?.name };
    return json(res, pick?.status ?? 200, pick?.body ?? {});
  });
}).listen(Number(process.env.PORT ?? 8081), function () {
  // Machine-readable ready line so a runner can use PORT=0 ephemeral ports.
  console.error(JSON.stringify({ event: "listening", port: this.address().port }));
});
`;
}
