import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { branchyardCredentialOwner, verifyInboundToken } from "@anvil/mcp-runtime";

const nonce = process.argv[2];
assert.match(nonce, /^[a-f0-9-]{36}$/);
const assertions = [];
function check(name, value) {
  assertions.push({ name, passed: Boolean(value) });
  assert.ok(value, name);
}
const config = JSON.parse(readFileSync("/work/server.json", "utf8"));
const tokenPath = process.env.ANVIL_GATEWAY_TOKEN_FILE;
check(
  "engine provisioned private token file",
  tokenPath?.startsWith(`${process.env.HOME}/`) && (statSync(tokenPath).mode & 0o777) === 0o600,
);
const token = readFileSync(tokenPath, "utf8").trim();
const verified = await verifyInboundToken(`Bearer ${token}`, {
  mode: "branchyard",
  issuer: config.connectors.issuer,
  audience: config.connectors.gateway,
  jwksUri: "file:///work/server-state/gateway/jwks.json",
});
check("native server JWKS verifies engine-issued turn token", verified.ok);
const claims = verified.claims;
const binding = config.google_identity.bindings[0];
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const subject = `google:${digest([binding.issuer, binding.subject])}`;
check("verified external Google subject preserved through engine", claims.sub === subject);
check("configured tenant preserved through engine", claims.by_tenant === binding.principal.tenant);
check("configured broker issuer preserved through engine", claims.iss === config.connectors.issuer);
check(
  "turn token names actual branch and turn",
  claims.by_branch.startsWith("validation/") && Boolean(claims.by_turn),
);
check(
  "turn token carries requested read grant",
  claims.by_grants.length === 1 &&
    claims.by_grants[0].connector === "storage" &&
    claims.by_grants[0].mode === "read",
);
check(
  "native effect proxy remains enabled",
  process.env.ANVIL_GATEWAY_URL !== config.connectors.gateway &&
    process.env.ANVIL_GATEWAY_URL?.startsWith("http://127.0.0.1:"),
);
const owner = `by:v1:${digest([claims.iss, claims.by_tenant, claims.sub])}`;
check(
  "verified namespace helper binds issuer tenant subject",
  branchyardCredentialOwner(claims) === owner && owner !== subject,
);
const packageRoot = `${process.env.HOME}/.branchyard/connectors/storage/typescript`;
execFileSync(
  "node",
  [
    "/work/runtime/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc",
    "-p",
    `${packageRoot}/tsconfig.json`,
  ],
  { stdio: "pipe" },
);
const { StorageClient } = await import(pathToFileURL(`${packageRoot}/dist/index.js`).href);
const client = new StorageClient();
const stats = async () =>
  (
    await fetch(
      new URL("/stats", JSON.parse(readFileSync("/work/qualification.json", "utf8")).mcpUrl),
      { signal: AbortSignal.timeout(20000) },
    )
  ).json();
const before = await stats();
const result = await client.list({});
check(
  "generated SDK executes real IAM-backed MCP read",
  JSON.stringify(result).includes("probe.json") && JSON.stringify(result).includes("nativeIam"),
);
const afterRead = await stats();
check(
  "actual captured upstream tool dispatched once",
  afterRead.toolNames.length === before.toolNames.length + 1 &&
    afterRead.toolNames.at(-1) === "native.bucket.list",
);
let refusal;
try {
  await client.confirmedList({}, { confirm: true });
} catch (error) {
  refusal = error;
}
check(
  "Anvil rejects mutation under engine-issued read grant",
  refusal?.code === "policy_denied" && refusal?.details?.code === "policy/grant_denied",
);
check(
  "actual gateway refusal uses issuer tenant subject namespace",
  refusal.details.principalId === owner,
);
const afterDeny = await stats();
check(
  "denied mutation sends zero upstream requests",
  afterDeny.requests === afterRead.requests &&
    afterDeny.toolNames.length === afterRead.toolNames.length,
);
writeFileSync(
  `/work/trust-proof-${nonce}.json`,
  JSON.stringify(
    {
      assertions,
      namespace: owner,
      subject,
      tenant: claims.by_tenant,
      issuer: claims.iss,
      branch: claims.by_branch,
      turn: claims.by_turn,
      nativeStatuses: afterDeny.nativeStatuses,
      tokenPrinted: false,
      modelCalled: false,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ proof: "passed", assertions: assertions.length, modelCalled: false }));
