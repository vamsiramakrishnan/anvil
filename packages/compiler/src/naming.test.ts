import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Operation, Operation as OperationSchema } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";
import { deriveNames, estatePathContext, resolveNameCollisions, singularize } from "./naming.js";

/**
 * The naming pass's resource-derivation rules and the singularize fix, from
 * docs/design/resource-derivation-and-tool-name-stutter.md. Every path shape
 * here is lifted from a measured estate (Plaid, Zendesk, GitHub, Stripe), so a
 * regression fails on the exact grammar that produced the defect in the wild.
 */

const specOf = (paths: string) => `openapi: 3.0.0
info: { title: svc, version: 1.0.0 }
paths:
${paths}`;

describe("singularize", () => {
  it("strips regular plurals without eating the stem", () => {
    // The old `-ses → -s` branch turned every `-ses` plural into a non-word
    // (releases → releas) that no operation's own name text could corroborate.
    const table: Record<string, string> = {
      releases: "release",
      databases: "database",
      searches: "search",
      branches: "branch",
      statuses: "status",
      buses: "bus",
      addresses: "address",
      cases: "case",
      boxes: "box",
      licenses: "license",
      viruses: "virus",
      companies: "company",
      dispatches: "dispatch",
      // `-che`/`-ze` stems must not lose their final `e` — over-stripping is
      // the defect, not the cure (GitHub actions caches, machine-sizes).
      caches: "cache",
      sizes: "size",
      // Already-singular words are left alone.
      status: "status",
      bus: "bus",
      address: "address",
    };
    for (const [plural, singular] of Object.entries(table)) {
      expect(singularize(plural), plural).toBe(singular);
    }
  });

  it("stays byte-identical to the mirrored copy in @anvil/refinement", () => {
    // The refinement executor duplicates `singularize` (compiler is a dev
    // dependency there — see the comment at its definition). The two bodies
    // must never drift: extract each function body from source and compare.
    const here = readFileSync(fileURLToPath(new URL("./naming.ts", import.meta.url)), "utf8");
    const mirror = readFileSync(
      fileURLToPath(new URL("../../refinement/src/vocabulary.ts", import.meta.url)),
      "utf8",
    );
    const bodyOf = (source: string, file: string): string => {
      const match = source.match(
        /singularize(?: =)? ?\(s: string\): string(?: =>)? \{\n([\s\S]*?)\n\};?\n/,
      );
      if (!match) throw new Error(`singularize not found in ${file}`);
      return match[1] as string;
    };
    expect(bodyOf(mirror, "vocabulary.ts")).toBe(bodyOf(here, "naming.ts"));
  });
});

describe("resource derivation for verb-shaped trailing segments (rules A and C)", () => {
  it("re-homes a bare CRUD-verb terminal segment onto the collection before it", async () => {
    // Plaid's grammar: POST /transactions/get reads transactions; today 252 of
    // its 351 operations took the verb as their resource.
    const air = await compile({
      spec: specOf(`  /transactions/get:
    post:
      operationId: transactionsGet
      responses: { "200": { description: ok } }
  /item/remove:
    post:
      operationId: itemRemove
      responses: { "200": { description: ok } }
`),
      serviceId: "plaid",
    });
    const byOpId = new Map(air.operations.map((o) => [o.sourceRef.operationId, o]));
    expect(byOpId.get("transactionsGet")?.effect.resource).toBe("transaction");
    expect(byOpId.get("itemRemove")?.effect.resource).toBe("item");
    // Resource-only: the action stays what the HTTP method produced.
    expect(byOpId.get("transactionsGet")?.effect.action).toBe("create");
  });

  it("re-homes a bulk-qualified verb segment (rule A) without touching the action", async () => {
    // Zendesk's grammar: GET /views/count_many counts views.
    const air = await compile({
      spec: specOf(`  /views/count_many:
    get:
      operationId: CountManyViews
      responses: { "200": { description: ok } }
`),
      serviceId: "zd",
    });
    const op = air.operations[0];
    expect(op?.effect.resource).toBe("view");
    expect(op?.effect.action).toBe("list");
  });

  it("never re-homes a verb word the estate uses as a real collection (the non-terminal guard)", async () => {
    // Insurance, not load-bearing: it fired zero times on all six measured
    // estates. `/reports/{id}/lines` makes `reports` a real collection here,
    // so `/x/reports`... a bare `/jobs/sync` stays re-homed while `/jobs/count`
    // is pinned by `/count/{id}/lines` declaring `count` a collection.
    const air = await compile({
      spec: specOf(`  /count/{count_id}/lines:
    get:
      operationId: listCountLines
      parameters:
        - { name: count_id, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
  /jobs/count:
    get:
      operationId: countJobs
      responses: { "200": { description: ok } }
  /jobs/sync:
    post:
      operationId: syncJobs
      responses: { "200": { description: ok } }
`),
      serviceId: "svc",
    });
    const byOpId = new Map(air.operations.map((o) => [o.sourceRef.operationId, o]));
    // `count` names a real collection in this estate — the guard keeps it.
    expect(byOpId.get("countJobs")?.effect.resource).toBe("count");
    // `sync` names none — rule C re-homes it.
    expect(byOpId.get("syncJobs")?.effect.resource).toBe("job");
  });

  it("leaves the shared-vocabulary trailing-verb rule alone (GET /field/search)", async () => {
    const air = await compile({
      spec: specOf(`  /field/search:
    get:
      operationId: getFieldsPaginated
      responses: { "200": { description: ok } }
`),
      serviceId: "jira",
    });
    const op = air.operations[0];
    expect(op?.effect.resource).toBe("field");
    expect(op?.cli.command).toBe("jira field search");
  });

  it("never re-homes on an adapter-lowered RPC estate (no estate context)", () => {
    // A WSDL/GraphQL/protobuf adapter lowers every operation to
    // `/<SyntheticWrapper>/<methodName>`. NetSuite's SOAP port declares bare
    // CRUD method names (`get`, `add`, `getAll`); re-homing them would collapse
    // the whole estate onto the wrapper as its resource. normalize passes no
    // estate context for those kinds, and without it the rules stay off.
    const lowered = deriveNames("netsuite", "/NetSuitePortType/get", "post", {
      operationId: "get",
    });
    expect(lowered.resource).toBe("get");
    const bulk = deriveNames("netsuite", "/NetSuitePortType/getAll", "post", {
      operationId: "getAll",
    });
    expect(bulk.resource).toBe("getAll");
    // The same shapes DO re-home on a resource-grammar estate.
    const rest = deriveNames(
      "plaid",
      "/transactions/get",
      "post",
      { operationId: "transactionsGet" },
      estatePathContext(["/transactions/get"]),
    );
    expect(rest.resource).toBe("transactions");
  });

  it("leaves GraphQL-style multi-word field segments as the resource", async () => {
    // The single-word guard the trailing-verb rule keeps: a lowered GraphQL
    // field must stay the resource, or every field collapses onto `Mutation`.
    const air = await compile({
      spec: specOf(`  /graphql/Mutation/acceptEnterpriseAdminInvitation:
    post:
      operationId: acceptEnterpriseAdminInvitation
      responses: { "200": { description: ok } }
`),
      serviceId: "gh",
    });
    expect(air.operations[0]?.effect.resource).toBe("acceptEnterpriseAdminInvitation");
  });
});

describe("disambiguation-suffix stutter", () => {
  const op = (partial: {
    id: string;
    canonicalName: string;
    path: string;
    method?: string;
  }): Operation =>
    OperationSchema.parse({
      id: partial.id,
      canonicalName: partial.canonicalName,
      displayName: partial.canonicalName,
      sourceRef: { kind: "openapi", path: partial.path, method: partial.method ?? "get" },
      effect: { kind: "read", action: "list", resource: "activity", risk: "none" },
      input: { params: [] },
      idempotency: { mode: "natural" },
      retries: { mode: "safe" },
      confirmation: { required: false },
      auth: { type: "none", scopes: [] },
      cli: { command: partial.id.split(".").join(" ") },
      mcp: { toolName: `svc_${partial.canonicalName}` },
      skill: { intentExamples: [] },
      state: "generated",
    });

  it("skips a distinguishing token the canonicalName already ends with", () => {
    // Zendesk's reported defect: GET /api/v2/activities/count canonicalizes to
    // count_activities; the shortest distinguishing token is `activities`, and
    // appending it yields `…_count_activities_activities`.
    const colliding = [
      op({
        id: "svc.activities.list",
        canonicalName: "count_activities",
        path: "/api/v2/activities/count",
      }),
      op({
        id: "svc.activities.list",
        canonicalName: "list_activities",
        path: "/api/v2/activities",
      }),
    ];
    resolveNameCollisions(colliding);
    for (const resolved of colliding) {
      const words = resolved.mcp.toolName.split("_");
      for (let i = 1; i < words.length; i++) {
        expect(words[i], resolved.mcp.toolName).not.toBe(words[i - 1]);
      }
    }
    // The four surfaces still move in lockstep: every suffix that landed on the
    // tool name landed on the id and the CLI command too.
    for (const resolved of colliding) {
      const suffix = resolved.id.split(".").at(-1) as string;
      expect(resolved.cli.command.endsWith(` ${suffix}`)).toBe(true);
      expect(resolved.mcp.toolName.endsWith(`_${suffix}`)).toBe(true);
      expect(resolved.canonicalName.endsWith(`_${suffix}`)).toBe(true);
    }
  });

  it("compares singularized, so a plural tail skips its singular token too", async () => {
    // GitHub's shape: canonicalName ends `…_for_enterprise`, the distinguishing
    // token is `enterprises` — a near-stutter the skip must also catch.
    const air = await compile({
      spec: specOf(`  /enterprises/{enterprise}/limit:
    get:
      operationId: getLimitForEnterprise
      parameters:
        - { name: enterprise, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
  /orgs/{org}/limit:
    get:
      operationId: getLimitForOrg
      parameters:
        - { name: org, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
`),
      serviceId: "gh",
    });
    const enterprise = air.operations.find(
      (o) => o.sourceRef.operationId === "getLimitForEnterprise",
    );
    expect(enterprise?.mcp.toolName).not.toMatch(/enterprise_enterprises$/);
  });
});

describe("service_prefix_stutter warning", () => {
  // BigQuery's shape: Discovery operationIds lead with the service name, so an
  // operator passing `--service bigquery` makes every tool name stutter
  // (`bigquery_bigquery_models_get`). The join is the vendor's name plus the
  // operator's choice — neither is rewritten; the choice gets a loud warning.
  const spec = specOf(`  /projects/{projectId}/models:
    get:
      operationId: bigquery.models.list
      parameters:
        - { name: projectId, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
`);

  it("warns when the operator's service id duplicates the operationIds' leading word", async () => {
    const air = await compile({ spec, serviceId: "bigquery" });
    const warning = air.diagnostics.find((d) => d.code === "service_prefix_stutter");
    expect(warning?.level).toBe("warning");
    expect(warning?.message).toContain('"bigquery"');
    // The join itself is untouched: the vendor's operationId stays verbatim.
    expect(air.operations[0]?.mcp.toolName).toBe("bigquery_bigquery_models_list");
  });

  it("stays silent when the service id is derived rather than operator-chosen", async () => {
    const air = await compile({ spec });
    expect(air.diagnostics.some((d) => d.code === "service_prefix_stutter")).toBe(false);
  });
});
