import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const base = process.env.BRANCHYARD_AUDIENCE;
const metadata = new URL(
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity",
);
metadata.searchParams.set("audience", base);
metadata.searchParams.set("format", "full");
const identityResponse = await fetch(metadata, {
  headers: { "Metadata-Flavor": "Google" },
  signal: AbortSignal.timeout(20000),
});
assert.equal(identityResponse.status, 200, "real metadata identity token");
const identity = await identityResponse.text();
const nonce = randomUUID();
const response = await fetch(`${base}/v1/repos/validation/tasks`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${identity}`,
    "content-type": "application/json",
    "Idempotency-Key": nonce,
  },
  body: JSON.stringify({
    prompt: `SH NODE_EXTRA_CA_CERTS=/trust/ca.pem node /work/runtime/qualification/trust-check.mjs ${nonce}`,
    harness: "gemini-cli",
    name: `trust-${nonce.slice(0, 8)}`,
    isolated: true,
    policy: { mode: "allow" },
    provision: { connectors: [{ connector: "storage", operations: ["*"], mode: "read" }] },
  }),
  signal: AbortSignal.timeout(30000),
});
if (process.env.ROLE === "deny") {
  assert.equal(response.status, 401, "unmapped real Google subject cannot create turn");
  await response.body?.cancel();
  console.log(JSON.stringify({ unmappedGoogleCallerDenied: true, httpStatus: 401 }));
} else {
  const accepted = await response.json();
  assert.equal(response.status, 202, `task admission: ${JSON.stringify(accepted)}`);
  let operation = accepted;
  const deadline = Date.now() + 180000;
  while (["queued", "running"].includes(operation.state) && Date.now() < deadline) {
    const poll = await fetch(`${base}/v1/operations/${encodeURIComponent(operation.id)}?wait=20`, {
      headers: { authorization: `Bearer ${identity}` },
      signal: AbortSignal.timeout(25000),
    });
    assert.equal(poll.status, 200, "native operation poll");
    operation = await poll.json();
  }
  writeFileSync("/work/trust-operation.json", JSON.stringify(operation, null, 2));
  assert.equal(
    operation.state,
    "succeeded",
    `native operation outcome: ${JSON.stringify(operation.error)}`,
  );
  const proof = JSON.parse(readFileSync(`/work/trust-proof-${nonce}.json`, "utf8"));
  assert.ok(proof.assertions.every((item) => item.passed));
  console.log(
    JSON.stringify({
      nativeGoogleAdmission: true,
      nativeOperationState: operation.state,
      ...proof,
    }),
  );
}
