import type { AirDocument, JsonSchema, Operation } from "@anvil/air";

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
        status,
        provenance: "synthetic",
        body: { error: { code: err.code, message: err.message ?? err.code } },
      });
    }
  }
  return scenarios;
}

/** Example input payload for an operation, for the skill's examples/ dir. */
export function exampleInput(op: Operation): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of op.input.params) {
    out[p.name] = p.example ?? exampleFromSchema(p.schema);
  }
  const body = op.input.body;
  if (body?.projection === "fields") {
    for (const f of body.fields) out[f.name] = exampleFromSchema(f.schema);
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

export function generateMockServerSource(air: AirDocument): string {
  return `#!/usr/bin/env node
// Generated mock server for "${air.service.id}". Serves recorded scenarios so
// agents and evals can be exercised without touching the real upstream.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scenarios = JSON.parse(
  readFileSync(fileURLToPath(new URL("./scenarios.json", import.meta.url)), "utf8"),
);
const active = process.env.ANVIL_MOCK_SCENARIO ?? null;

createServer((req, res) => {
  const pick =
    scenarios.find((s) => (active ? s.name === active : s.name.endsWith("_success"))) ?? scenarios[0];
  res.writeHead(pick?.status ?? 200, { "content-type": "application/json" });
  res.end(JSON.stringify(pick?.body ?? {}));
}).listen(process.env.PORT ?? 8081, () => console.error("mock listening"));
`;
}
