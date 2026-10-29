import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { airToJson, loadAirDocument, Operation } from "@anvil/air";

const work = "/work";
mkdirSync(`${work}/workspace/storage`, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
writeFileSync(`${work}/fixture-signing.pem`, privateKey.export({ type: "pkcs8", format: "pem" }), {
  mode: 0o600,
});
writeFileSync(
  `${work}/jwks.json`,
  JSON.stringify({
    keys: [
      {
        ...publicKey.export({ format: "jwk" }),
        kid: "qualification-20261029",
        alg: "EdDSA",
        use: "sig",
      },
    ],
  }),
);
writeFileSync(`${work}/vault.key`, randomBytes(32), { mode: 0o600 });
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
    cli: { command: confirmed ? "confirmed-list" : "list" },
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
      tls: { cert: "/tls/server.pem", key: "/tls/server.key" },
      google_identity: {
        audience: process.env.BRANCHYARD_AUDIENCE,
        bindings: [
          {
            issuer: "https://accounts.google.com",
            subject: process.env.ALLOWED_GOOGLE_SUBJECT,
            principal: {
              name: "wif-reader",
              tenant: "validation-20261029",
              scopes: ["read"],
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
