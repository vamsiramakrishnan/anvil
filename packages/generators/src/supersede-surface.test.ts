import { type AirDocument, loadAirDocument, Operation, type Workflow } from "@anvil/air";
import { buildMcpServer } from "@anvil/mcp-runtime";
import type { Transport } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { generateCliSource } from "./entrypoints.js";
import { sdkOperations, sdkPlan } from "./sdk/plan.js";

/**
 * The boundary `Workflow.supersedes` must never cross.
 *
 * Superseding an operation is a DISCLOSURE decision about one surface: the MCP
 * `tools/list`. It is not an approval decision, not a deprecation, and not a
 * withdrawal. The operation stays in AIR, keeps generating into the CLI and all
 * four client SDKs, and keeps running under exactly the safety contract it had.
 *
 * This is the test that would catch someone "simplifying" the feature by
 * filtering superseded operations out of AIR itself, or out of `sdkOperations`
 * — which reads as a tidy-up and is in fact a silent removal of capability from
 * every non-MCP consumer of the bundle.
 *
 * It lives in `@anvil/generators` because this is the one package that can see
 * both surfaces at once: it depends on `@anvil/mcp-runtime` and owns the CLI
 * and SDK projections.
 */

const transport: Transport = {
  send: async () => ({ status: 200, headers: {}, body: "{}" }),
};

function op(id: string, name: string): Operation {
  return Operation.parse({
    id,
    canonicalName: name,
    displayName: name,
    sourceRef: { kind: "openapi", path: `/${name}`, method: "get" },
    effect: { kind: "read", action: "get", resource: "thing", risk: "low", reversible: false },
    input: { params: [] },
    idempotency: {
      mode: "none",
      mechanism: "header",
      key: "Idempotency-Key",
      keyDerivation: "client_supplied",
    },
    retries: { mode: "safe", maxAttempts: 3, backoff: "exponential", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: `things ${name}` },
    mcp: { toolName: name },
    skill: { intentExamples: [] },
    state: "approved",
    output: { schema: { type: "object", properties: { id: { type: "string" } } } },
  });
}

const workflow: Workflow = {
  id: "things.all.fetch_thing",
  capabilityId: "things.all",
  displayName: "Fetch a thing",
  description: "Find it, then read it.",
  intentExamples: [],
  steps: [
    { operationId: "things.list", description: "", optional: false, bindings: {} },
    { operationId: "things.get", description: "", optional: false, bindings: {} },
  ],
  humanApproval: false,
  supersedes: ["things.get"],
  state: "approved",
  evidence: { claims: [] },
};

function document(withSupersession: boolean): AirDocument {
  const { supersedes, ...withoutSupersession } = workflow;
  return loadAirDocument({
    service: { id: "things", version: "1.0.0", source: { kind: "openapi" } },
    operations: [op("things.list", "list_things"), op("things.get", "get_thing")],
    workflows: [withSupersession ? workflow : withoutSupersession],
  });
}

async function servedToolNames(air: AirDocument): Promise<string[]> {
  const server = buildMcpServer(air, {
    contextFor: () => ({
      transport,
      serviceId: "things",
      baseUrl: "http://things",
      allowedHosts: ["things"],
    }),
  });
  const client = new Client({ name: "t", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  await client.close();
  return listed.tools.map((tool) => tool.name).sort();
}

describe("supersession shrinks the MCP surface and nothing else", () => {
  it("removes the tool from tools/list", async () => {
    expect(await servedToolNames(document(false))).toEqual([
      "get_thing",
      "list_things",
      "things_all_fetch_thing",
    ]);
    expect(await servedToolNames(document(true))).toEqual([
      "list_things",
      "things_all_fetch_thing",
    ]);
  });

  it("leaves the operation in AIR", () => {
    expect(document(true).operations.map((operation) => operation.id)).toContain("things.get");
  });

  it("leaves the CLI surface byte-identical", () => {
    // Not merely "still contains the command": IDENTICAL. A superseded
    // operation must not change one character of the generated CLI, because the
    // CLI is where an operator reaches an operation the agent no longer routes
    // to on its own.
    expect(generateCliSource(document(true))).toBe(generateCliSource(document(false)));
  });

  it("leaves every client SDK's operation set untouched", () => {
    const superseded = sdkOperations(document(true)).map((operation) => operation.id);
    expect(superseded).toEqual(sdkOperations(document(false)).map((operation) => operation.id));
    expect(superseded).toContain("things.get");
    // And the plan the four language emitters read from is identical too, so no
    // emitter can drift toward honouring supersession on its own.
    expect(JSON.stringify(sdkPlan(document(true)))).toBe(JSON.stringify(sdkPlan(document(false))));
  });
});
