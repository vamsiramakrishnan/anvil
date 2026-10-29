import { mkdirSync, writeFileSync } from "node:fs";
import { airToJson, loadAirDocument, Operation } from "@anvil/air";

const work = "/work";
writeFileSync("/work/qualification.json", JSON.stringify({ mcpUrl: process.env.MCP_URL }));
mkdirSync(`${work}/workspace/storage`, { recursive: true });
const operation = (confirmed) =>
  Operation.parse({
    id: confirmed ? "storage.confirmed_list" : "storage.list",
    canonicalName: confirmed ? "confirmed_list" : "list",
    displayName: "List the dedicated validation bucket",
    state: "approved",
    sourceRef: { kind: "mcp", operationId: "native.bucket.list" },
    effect: {
      kind: confirmed ? "mutation" : "read",
      action: "list",
      risk: confirmed ? "medium" : "low",
      reversible: true,
    },
    input: { params: [], schema: { type: "object", properties: {}, additionalProperties: false } },
    idempotency: { mode: confirmed ? "none" : "natural", mechanism: "none" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: confirmed },
    auth: {
      type: "workload_identity",
      principal: "service",
      secretSource: "workload_identity",
      scopes: ["https://www.googleapis.com/auth/devstorage.read_only"],
    },
    cli: { command: confirmed ? "storage confirmed-list" : "storage list" },
    mcp: { toolName: confirmed ? "public_confirmed_list" : "public_bucket_list" },
    skill: { intentExamples: [] },
  });
const air = loadAirDocument({
  service: {
    id: "storage",
    version: "1.0.0",
    source: { kind: "mcp" },
    servers: [{ url: process.env.MCP_URL }],
  },
  operations: [operation(false), operation(true)],
});
writeFileSync(`${work}/workspace/storage/air.json`, airToJson(air));
if (process.env.ALLOWED_GOOGLE_SUBJECT) {
  writeFileSync(
    `${work}/server.json`,
    JSON.stringify({
      listen: "0.0.0.0:8787",
      data_dir: `${work}/server-state`,
      repos: { validation: `${work}/repo` },
      by_path: `${work}/by`,
      inventory: false,
      metrics: {},
      harness_commands: { "gemini-cli": ["/work/fake-acp-agent"] },
      connectors: {
        gateway: "http://127.0.0.1:8080/mcp",
        issuer: process.env.BRANCHYARD_AUDIENCE,
        bundles: "/work/workspace",
        anvil: ["node", "/work/runtime/dist/bin-anvil.js"],
        run_gateway: true,
      },
      tls: { cert: "/tls/server.pem", key: "/tls/server.key" },
      google_identity: {
        audience: process.env.BRANCHYARD_AUDIENCE,
        bindings: [
          {
            issuer: "https://accounts.google.com",
            subject: process.env.ALLOWED_GOOGLE_SUBJECT,
            principal: {
              name: "wif-runner",
              tenant: "validation-20261029",
              scopes: ["read", "run"],
              repos: ["validation"],
            },
          },
        ],
      },
    }),
    { mode: 0o600 },
  );
}
console.log(
  JSON.stringify({ prepared: true, qualificationFixture: true, sourceCheckoutRequired: false }),
);
