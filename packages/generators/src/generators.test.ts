import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AirDocument, loadAirDocument, Operation as OperationSchema } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { MockTransport } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { generateBundle } from "./bundle.js";
import { buildMcpServer } from "./mcp.js";
import { exampleFromSchema, exampleInput } from "./mock.js";
import { buildToolResources } from "./resources.js";

const read = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/payments/${rel}`, import.meta.url)),
    "utf8",
  );

let air: AirDocument;

beforeAll(async () => {
  air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
});

async function connect(server: ReturnType<typeof buildMcpServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("MCP server", () => {
  it("exposes one tool per approved operation with risk-visible metadata", async () => {
    const server = buildMcpServer(air, {
      contextFor: () => ({
        transport: new MockTransport(() => ({ status: 200, headers: {}, body: "{}" })),
        baseUrl: "https://payments.internal.example.com",
        allowedHosts: ["payments.internal.example.com"],
        env: "prod",
      }),
    });
    const client = await connect(server);
    const { tools } = await client.listTools();
    const refund = tools.find((t) => t.name === "payments_create_refund");
    expect(refund).toBeDefined();
    expect(refund?.annotations?.destructiveHint).toBe(true);
    expect(refund?.annotations?.readOnlyHint).toBe(false);
    expect(refund?.description).toMatch(/irreversible|idempotency|confirm/i);
    // Input schema requires the safety fields.
    expect(refund?.inputSchema.required).toEqual(
      expect.arrayContaining(["payment_id", "amount", "currency", "idempotency_key", "confirm"]),
    );
    await client.close();
  });

  it("refuses an unsafe call without confirm, and executes with it", async () => {
    const transport = new MockTransport(() => ({
      status: 201,
      headers: {},
      body: JSON.stringify({ id: "re_1" }),
    }));
    const credentials = {
      async resolve() {
        return { headers: { Authorization: "Bearer t" } };
      },
    };
    const server = buildMcpServer(air, {
      contextFor: () => ({
        transport,
        credentials,
        authProfile: "prod",
        baseUrl: "https://payments.internal.example.com",
        allowedHosts: ["payments.internal.example.com"],
        // Mechanics test: dev allows the in-memory ledger. The prod durable-ledger
        // fail-closed contract is covered by the runtime executor tests.
        env: "dev",
      }),
    });
    const client = await connect(server);

    // The tool's input schema makes confirm a required `const: true`, so the MCP
    // layer refuses a call without confirmation before it can reach upstream.
    const refused = await client.callTool({
      name: "payments_create_refund",
      arguments: {
        payment_id: "pay_1",
        amount: 2500,
        currency: "USD",
        idempotency_key: "k1",
        confirm: false,
      },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/confirm/i);
    expect(transport.requests).toHaveLength(0);

    const ok = await client.callTool({
      name: "payments_create_refund",
      arguments: {
        payment_id: "pay_1",
        amount: 2500,
        currency: "USD",
        idempotency_key: "k1",
        confirm: true,
      },
    });
    expect(ok.isError).toBeFalsy();
    expect(transport.requests).toHaveLength(1);
    await client.close();
  });

  it("serves the skill and CLI install manifest as MCP resources", async () => {
    const server = buildMcpServer(air, {
      contextFor: () => ({
        transport: new MockTransport(() => ({ status: 200, headers: {}, body: "{}" })),
        baseUrl: "https://payments.internal.example.com",
        allowedHosts: ["payments.internal.example.com"],
        env: "prod",
      }),
      resources: buildToolResources(air, { mcpEndpoint: "https://payments-tools.run.app/mcp" }),
    });
    const client = await connect(server);
    const { resources } = await client.listResources();
    const skill = resources.find((r) => r.uri === "anvil://skill/payments/SKILL.md");
    const cli = resources.find((r) => r.uri === "anvil://cli/payments/install.json");
    expect(skill).toBeDefined();
    expect(cli).toBeDefined();

    const skillRead = await client.readResource({ uri: "anvil://skill/payments/SKILL.md" });
    expect(skillRead.contents[0]?.text).toContain("Safety rules");
    const cliRead = await client.readResource({ uri: "anvil://cli/payments/install.json" });
    expect(cliRead.contents[0]?.text).toContain("payments-tools.run.app/mcp");
    await client.close();
  });
});

describe("resources", () => {
  it("marks SKILL.md for the assistant audience with high priority", () => {
    const resources = buildToolResources(air);
    const skill = resources.find((r) => r.uri === "anvil://skill/payments/SKILL.md");
    expect(skill?.audience).toContain("assistant");
    expect(skill?.priority).toBeGreaterThan(0.9);
  });
});

describe("capabilities in generated artifacts", () => {
  it("indexes capabilities in the catalog with their operations", () => {
    const { files } = generateBundle(air);
    const catalog = JSON.parse(files["catalog.json"] as string);
    const refunds = catalog.capabilities.find((c: { id: string }) => c.id === "payments.refunds");
    expect(refunds).toBeDefined();
    expect(refunds.workflows).toContain("payments.refunds.refund_customer");
    // Operations carry their capability back-reference.
    const refundOp = catalog.operations.find((o: { id: string }) => o.id.includes("refund"));
    expect(refundOp.capability).toBe("payments.refunds");
  });

  it("leads the skill with capabilities and renders authored workflows", () => {
    const { files } = generateBundle(air);
    const skill = files["skill/SKILL.md"] as string;
    expect(skill).toMatch(/Start with capabilities/);
    expect(skill).toMatch(/refunds/);
    const capsRef = files["skill/reference/capabilities.md"] as string;
    expect(capsRef).toContain("payments.refunds");
    const workflows = files["skill/reference/workflows.md"] as string;
    expect(workflows).toContain("Refund a customer");
    expect(workflows).toMatch(/human approval/i);
  });

  it("never advertises unapproved operations in the capability skill docs", async () => {
    // No manifest → nothing is approved. The skill is the exposed surface, so
    // its capability docs must not list any operation command.
    const unapproved = await compile({ spec: read("openapi.yaml"), serviceId: "payments" });
    expect(unapproved.operations.every((o) => o.state !== "approved")).toBe(true);
    const { files } = generateBundle(unapproved);
    const capsRef = files["skill/reference/capabilities.md"] as string;
    expect(capsRef).toContain("No approved capabilities");
    expect(capsRef).not.toContain("payments refunds create");
    const skill = files["skill/SKILL.md"] as string;
    expect(skill).not.toContain("payments refunds create");
  });

  it("gives the skill a valid Agent-Skill name slug", async () => {
    // With no serviceId, the id derives from the title "Payments API" as
    // `payments_api`. A skill `name` must be a lowercase-hyphen slug — an
    // underscore makes the skill unloadable by a harness — so it is kebab-cased.
    const derived = await compile({ spec: read("openapi.yaml") });
    expect(derived.service.id).toBe("payments_api");
    const { files } = generateBundle(derived);
    const front = (files["skill/SKILL.md"] as string).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const name = front.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "";
    const description = front.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(name).toBe("payments-api");
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
    const manifest = files["skill/manifest.yaml"] as string;
    expect(manifest).toContain("name: payments-api");
    expect(manifest).toContain("service_id: payments_api");
  });
});

describe("bundle", () => {
  it("emits every aligned artifact from one AIR", () => {
    const { files } = generateBundle(air);
    const paths = Object.keys(files);
    for (const expected of [
      "air.yaml",
      "air.json",
      "catalog.json",
      "cli/payments.mjs",
      "mcp/server.js",
      "runtime/server.js",
      "runtime/operations.manifest.json",
      "skill/SKILL.md",
      "skill/reference/operations.md",
      "skill/reference/capabilities.md",
      "deploy/Dockerfile",
      "deploy/terraform/main.tf",
      "mock/scenarios.json",
      "tests/conformance.test.ts",
      "package.json",
    ]) {
      expect(paths, `missing ${expected}`).toContain(expected);
    }
  });

  it("compiles only approved operations into the runtime manifest", () => {
    const { files } = generateBundle(air);
    const manifest = JSON.parse(files["runtime/operations.manifest.json"] as string);
    const approved = air.operations.filter((o) => o.state === "approved").length;
    expect(manifest.operations).toHaveLength(approved);
    // The refund must keep its confirmation + idempotency contract post-compile.
    const refund = manifest.operations.find((o: { id: string }) => o.id.includes("refund"));
    expect(refund.confirmation.required).toBe(true);
    expect(refund.idempotency.mode).toBe("required");
  });

  it("generates a conformance test asserting the safety contract", () => {
    const { files } = generateBundle(air);
    const test = files["tests/conformance.test.ts"] as string;
    expect(test).toContain("requires confirmation");
    expect(test).toContain("never auto-retries");
  });
});

describe("skill package format", () => {
  it("counts only capabilities with approved members in the manifest", async () => {
    // Nothing approved → every capability is invisible; the manifest must say
    // 0, not the raw capability count (the audit's "29 capabilities, 4 ops").
    const unapproved = await compile({ spec: read("openapi.yaml"), serviceId: "payments" });
    const { files } = generateBundle(unapproved);
    expect(files["skill/manifest.yaml"]).toContain("capabilities: 0");
    // With the manifest, every payments capability has an approved member.
    const approved = generateBundle(air).files["skill/manifest.yaml"] as string;
    expect(approved).toContain(`capabilities: ${air.capabilities.length}`);
  });

  it("folds capability names into the skill description for intent routing", () => {
    const { files } = generateBundle(air);
    const front = (files["skill/SKILL.md"] as string).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const description = front.match(/^description:\s*(.+)$/m)?.[1] ?? "";
    expect(description).toContain("Refunds");
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toContain("Use when");
  });

  it("points each operation at its schema and example, with the confirmation reason", () => {
    const { files } = generateBundle(air);
    const ref = files["skill/reference/operations.md"] as string;
    expect(ref).toContain("../schemas/create_refund.schema.json");
    expect(ref).toContain("../examples/create_refund.json");
    // The manifest-declared reason must surface where the agent reads the contract.
    expect(ref).toContain("Confirmation required");
    expect(ref).toContain("This operation creates an irreversible financial mutation.");
    const idem = files["skill/reference/idempotency.md"] as string;
    expect(idem).toContain("This operation creates an irreversible financial mutation");
  });

  it("teaches setup (env-var NAMES only) and links it from SKILL.md and errors.md", () => {
    const { files } = generateBundle(air);
    const setup = files["skill/reference/setup.md"] as string;
    for (const name of [
      "ANVIL_DEFAULT_TOKEN",
      "ANVIL_BASE_URL",
      "ANVIL_ENV",
      "ANVIL_ALLOWED_HOSTS",
      "ANVIL_LEDGER",
      "--auth-profile",
    ]) {
      expect(setup, `setup.md must name ${name}`).toContain(name);
    }
    expect(files["skill/SKILL.md"]).toContain("reference/setup.md");
    const errors = files["skill/reference/errors.md"] as string;
    expect(errors).toMatch(/auth_required[^\n]*setup\.md/);
    expect(errors).toMatch(/policy_denied[^\n]*setup\.md/);
  });

  it("omits empty eval suites and explains the omission in a README", () => {
    const { files } = generateBundle(air);
    // Payments operations carry no intent examples → operation_selection would
    // be an empty suite; it must be absent, and the README must say why.
    expect(files["skill/evals/operation_selection.yaml"]).toBeUndefined();
    expect(files["skill/evals/unsafe_operation_refusal.yaml"]).toBeDefined();
    const readme = files["skill/evals/README.md"] as string;
    expect(readme).toMatch(/^---\n/);
    expect(readme).toContain("operation_selection");
    expect(readme).toContain("skill.intent_examples");
  });

  it("gives every skill markdown file self-describing frontmatter", () => {
    const { files } = generateBundle(air);
    for (const [rel, text] of Object.entries(files)) {
      if (!rel.startsWith("skill/") || !rel.endsWith(".md")) continue;
      const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
      expect(front, `${rel} must carry frontmatter`).toMatch(/^name:\s*\S+/m);
      expect(front, `${rel} must describe itself`).toMatch(/^description:\s*\S+/m);
    }
  });
});

describe("GCP-native deploy (single owner per concern)", () => {
  it("emits exactly one deploy path: Cloud Build (pipeline) + Terraform (infra)", () => {
    const { files } = generateBundle(air);
    for (const p of [
      "deploy/cloudbuild.yaml",
      "deploy/terraform/main.tf",
      "deploy/terraform/variables.tf",
      "deploy/env.schema.json",
      "deploy/secrets.required.yaml",
    ]) {
      expect(Object.keys(files), `missing ${p}`).toContain(p);
    }
    // The overlapping mechanisms are gone — a knative service.yaml, an
    // iam.plan.json, and per-env overlays all set the same knobs and drifted.
    for (const gone of [
      "deploy/cloudrun.service.yaml",
      "deploy/iam.plan.json",
      "deploy/overlays/dev.env.yaml",
      "deploy/overlays/prod.env.yaml",
      "deploy/artifact-metadata.json",
    ]) {
      expect(Object.keys(files), `should not emit ${gone}`).not.toContain(gone);
    }
  });

  it("ships a prebuilt runtime image (no in-image Anvil build)", () => {
    const { files } = generateBundle(air);
    const dockerfile = files["deploy/Dockerfile"] as string;
    expect(dockerfile).not.toContain("pnpm build");
    expect(dockerfile).toContain("runtime/server.js");
  });

  it("grants least-privilege ledger IAM without owning the shared Firestore singleton", () => {
    const { files } = generateBundle(air);
    const tf = files["deploy/terraform/main.tf"] as string;
    // The SA gets scoped datastore access...
    expect(tf).toContain("roles/datastore.user");
    // ...but the (default) Firestore database is a project singleton / prereq —
    // creating it per-capability would collide across capability modules.
    expect(tf).not.toContain('resource "google_firestore_database"');
    // Same for the Artifact Registry repo: a shared platform prereq, not owned here.
    expect(tf).not.toContain('resource "google_artifact_registry_repository"');
    // Secret access is scoped to the one secret resource, not project-wide.
    expect(tf).toContain("google_secret_manager_secret_iam_member");
    // No project owner/editor anywhere.
    expect(tf).not.toContain("roles/owner");
    expect(tf).not.toContain("roles/editor");
    // Terraform owns ANVIL_LEDGER so the fail-closed contract holds at runtime.
    expect(tf).toContain("ANVIL_LEDGER");
  });

  it("uses durable remote state and never auto-applies (plan-only pipeline)", () => {
    const { files } = generateBundle(air);
    const cb = files["deploy/cloudbuild.yaml"] as string;
    const tf = files["deploy/terraform/main.tf"] as string;
    // Remote state is mandatory: a backend block + a bound init.
    expect(tf).toContain('backend "gcs"');
    expect(cb).toContain("backend-config");
    // Cloud Build produces a plan, never an auto-approved apply.
    expect(cb).toContain("terraform plan");
    expect(cb).not.toContain("-auto-approve");
    expect(cb).not.toContain("terraform apply");
  });

  it("has exactly one owner for the image tag and never leaks PROJECT/REGION placeholders", () => {
    const { files } = generateBundle(air);
    const cb = files["deploy/cloudbuild.yaml"] as string;
    const tf = files["deploy/terraform/main.tf"] as string;
    // Cloud Build sets no runtime config — no --set-env-vars, no `gcloud run
    // deploy`. It only builds/pushes and hands Terraform the image tag.
    expect(cb).not.toContain("set-env-vars");
    expect(cb).not.toContain("run\n      - deploy");
    expect(cb).toContain("image_tag");
    // Terraform derives the image entirely from vars — no literal placeholders
    // that a human must hand-edit (the old knative yaml had literal PROJECT/REGION).
    expect(tf).not.toContain("PROJECT/locations/REGION");
    expect(tf).not.toContain("REGION-docker.pkg.dev/PROJECT");
  });
});

describe("example synthesis (mock + loopback inputs)", () => {
  it("synthesizes through a materialized allOf with a truncation stub (finding #31)", () => {
    // The exact Travelport shape: a depth-truncation stub (no type, only a
    // description) composed with the object carrying the real fields.
    const schema = {
      allOf: [
        { description: "…nested one level deep…" },
        {
          type: "object",
          required: ["TargetBranch"],
          properties: {
            TargetBranch: { type: "string" },
            SearchAirLeg: { type: "array", items: { type: "object" } },
          },
        },
      ],
    };
    expect(exampleFromSchema(schema)).toEqual({
      TargetBranch: "example",
      SearchAirLeg: [{}],
    });
  });

  it("deep-merges allOf members, later members winning on key conflict", () => {
    const schema = {
      allOf: [
        {
          type: "object",
          properties: {
            a: { type: "integer" },
            nested: { type: "object", properties: { x: { type: "string" } } },
          },
        },
        {
          type: "object",
          properties: {
            a: { type: "string" },
            nested: { type: "object", properties: { y: { type: "boolean" } } },
          },
        },
      ],
    };
    expect(exampleFromSchema(schema)).toEqual({
      a: "example",
      nested: { x: "example", y: true },
    });
  });

  it("picks the first member of oneOf/anyOf and treats bare stubs as {}", () => {
    expect(exampleFromSchema({ oneOf: [{ type: "integer" }, { type: "string" }] })).toBe(1);
    expect(exampleFromSchema({ anyOf: [{ type: "boolean" }] })).toBe(true);
    // A typeless annotation-only stub is an empty object, not null.
    expect(exampleFromSchema({ description: "truncated" })).toEqual({});
    // A typeless schema that still declares properties is an object in all but name.
    expect(exampleFromSchema({ properties: { id: { type: "string" } } })).toEqual({
      id: "example",
    });
  });

  it("always synthesizes at least {} for a required whole-projection body", () => {
    const op = OperationSchema.parse({
      id: "svc.thing.create",
      canonicalName: "create_thing",
      displayName: "Create thing",
      sourceRef: { kind: "wsdl", path: "/Port/CreateThing", method: "post" },
      effect: { kind: "mutation", resource: "thing", risk: "medium", reversible: true },
      input: {
        params: [],
        body: {
          contentType: "application/json",
          required: true,
          // Unsynthesizable-by-type body: only an annotation stub survived.
          schema: { description: "truncated" },
          projection: "whole",
          fields: [],
        },
      },
      idempotency: { mode: "none", mechanism: "none", keyDerivation: "none" },
      retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
      confirmation: { required: false },
      auth: { type: "none", scopes: [] },
      cli: { command: "svc thing create" },
      mcp: { toolName: "svc_create_thing" },
      skill: { intentExamples: [] },
    });
    expect(exampleInput(op).body).toEqual({});
  });
});

// Keep the loader import meaningful for downstream consumers.
void loadAirDocument;
