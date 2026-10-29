import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const key = createPrivateKey(readFileSync("/work/fixture-signing.pem"));
const gateway = "http://127.0.0.1:8080/mcp";
const mint = (grants) => {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "EdDSA", kid: "qualification-20261029" })}.${encode({ iss: "branchyard:local:wif-20261029", aud: gateway, sub: "live:validation", by_tenant: "validation-20261029", by_branch: "probe", by_turn: randomUUID(), by_grants: grants, iat: now, nbf: now, exp: now + 300, jti: randomUUID() })}`;
  return `${body}.${sign(null, Buffer.from(body), key).toString("base64url")}`;
};
const invoke = async (grants, name) => {
  const client = new Client({ name: "live-qualification", version: "20261029" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(gateway), {
        requestInit: { headers: { authorization: `Bearer ${mint(grants)}` } },
      }),
    );
    return await client.callTool({ name, arguments: {} });
  } finally {
    await client.close();
  }
};
const inspect = async () => (await fetch(new URL("/stats", process.env.MCP_URL))).json();
const assertions = [];
const check = (name, value) => {
  assertions.push({ name, passed: Boolean(value) });
  if (!value) throw new Error(`Qualification failed: ${name}`);
};
const grants = [{ connector: "storage", operations: ["*"], mode: "write", confirm: "allow" }];
const before = await inspect();
check("grant denial", (await invoke([], "storage__public_bucket_list")).isError);
check("confirmation denial", (await invoke(grants, "storage__public_confirmed_list")).isError);
const gated = await inspect();
check("policy gates make zero upstream requests", before.requests === gated.requests);
const result = await invoke(grants, "storage__public_bucket_list");
const after = await inspect();
if (process.env.ROLE === "allow") {
  check(
    "WIF ADC protected MCP native IAM allow",
    !result.isError && JSON.stringify(result).includes("probe.json"),
  );
  check("captured name retained", after.toolNames.at(-1) === "native.bucket.list");
} else {
  check(
    "WIF ADC protected MCP native IAM deny",
    result.isError && (after.nativeStatuses["403"] ?? 0) > (gated.nativeStatuses["403"] ?? 0),
  );
  check("denied workload executes no tool", after.toolNames.length === gated.toolNames.length);
}
console.log(
  JSON.stringify({
    role: process.env.ROLE,
    assertions,
    upstream: after,
    localBranchyardTokenFixture: true,
  }),
);
