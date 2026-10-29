import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const rows = readFileSync("/work/server-state/gateway/audit.jsonl", "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse);
assert.equal(rows.length, 2);
assert.equal(rows[0].decision, "allowed");
assert.equal(rows[1].rule, "policy/grant_denied");
assert.equal(rows[0].sub, rows[1].sub);
assert.equal(rows[0].by_tenant, rows[1].by_tenant);
const stats = await (await fetch(new URL("/stats", process.env.MCP_URL))).json();
assert.equal(stats.toolNames.length, 1);
assert.equal(stats.requests, 4);
console.log(
  JSON.stringify({
    auditMatchesAdmittedTurn: true,
    unmappedCallerCreatedNoGatewayCalls: true,
    stats,
    binaries: Object.fromEntries(
      ["by", "branchyard-server", "fake-acp-agent"].map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(`/work/${name}`))
          .digest("hex"),
      ]),
    ),
  }),
);
