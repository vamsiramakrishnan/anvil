#!/usr/bin/env node
// The Branchyard connector fixture, end to end (docs/branchyard.md):
//
//   node examples/github-mini/e2e.mjs [--work <dir>] [--anvil <bin-anvil.js>] [--python python3] [--keep]
//
// 1. starts the mock upstream (mock-upstream.mjs), expecting one bearer token;
// 2. compiles this spec into <work>/workspace/github, pointed at the mock;
// 3. packages it for a harness home (`anvil package harness`) and writes the
//    INDEX.md a github:read grant produces (`anvil connectors index`);
// 4. makes a yard key, its JWKS file, and a vault key;
// 5. serves the workspace with `anvil serve mcp <ws> --fleet --http <port>` in
//    branchyard mode, with ANVIL_AUDIT_FILE;
// 6. connects the person's account with `anvil connect --api-key-stdin` and a
//    connect token (`by_purpose: "connect"`), after checking the turn token
//    is refused there;
// 7. with a token granting github:read, lists issues through the packaged
//    Python SDK in gateway mode (GITHUB_TOKEN is set to a wrong value and
//    must not be read), and asks for issues.create, which must be refused
//    policy_denied without reaching the upstream;
// 8. checks the audit log has exactly those two lines;
// 9. with a second turn's token granting github:write (confirm allowed),
//    drives the effect contract (ADR-0030) over MCP and REST: a comment
//    created with `_meta.idempotency_key` reports its inverse (the key reached
//    the upstream), and the inverse, called over REST under the same grant,
//    deletes it; an issue created over REST reports its compensation
//    (`X-Anvil-Effect`), which closes it; a release staged with
//    `_meta.stage` is created as a draft and promoted by the call the report
//    names; a read reports the `read` default; and the audit lines carry the
//    effect class and ledger id.
//
// Prints one JSON summary line and exits 0 when every check holds.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMockUpstream } from "./mock-upstream.mjs";
import { keygen, mint } from "./yard-keys.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const anvil = resolve(flag("anvil") ?? process.env.ANVIL_BIN ?? join(here, "../../packages/cli/dist/bin-anvil.js"));
const python = flag("python") ?? "python3";
const work = resolve(flag("work") ?? mkdtempSync(join(tmpdir(), "anvil-branchyard-e2e-")));
const keep = args.includes("--keep");
const UPSTREAM_TOKEN = "e2e-upstream-pat";
const ISSUER = "branchyard:local:e2e";
const SUB = "local:e2e-person";

function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

// Asynchronous on purpose: the mock upstream runs in this process, so a
// blocking spawn would stop it answering the gateway.
function run(command, argv, options = {}) {
  const { input, ...spawnOptions } = options;
  return new Promise((done, fail) => {
    const child = spawn(command, argv, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", fail);
    child.on("close", (status) => {
      if (status === 0) done(stdout);
      else fail(new Error(`${command} ${argv.join(" ")} exited ${status}: ${stderr || stdout}`));
    });
    child.stdin.end(input ?? "");
  });
}

async function waitFor(url, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} never came up`);
}

/** The caller's environment without credentials or proxies: the fixture talks to loopback only. */
function hermetic(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (/TOKEN|SECRET|PASSWORD|API_KEY|PROXY|CREDENTIAL/i.test(key)) continue;
    if (key.startsWith("ANVIL_")) continue;
    out[key] = value;
  }
  return out;
}

/**
 * A minimal MCP Streamable HTTP client: initialize, then tools/call with an
 * optional `_meta`. Answers may come back as JSON or as one SSE event.
 */
async function mcpSession(url, token) {
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  let id = 0;
  const post = async (message) => {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(message) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) headers["mcp-session-id"] = sid;
    const text = await res.text();
    if (!text.trim()) return undefined;
    const payload = (res.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .at(-1)
      : text;
    return JSON.parse(payload);
  };
  const init = await post({
    jsonrpc: "2.0",
    id: ++id,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
  });
  headers["mcp-protocol-version"] = init.result.protocolVersion;
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    async call(name, args, meta) {
      const answer = await post({
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
      });
      if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
      return answer.result;
    },
    close: () => fetch(url, { method: "DELETE", headers }).then((res) => res.text()),
  };
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
}

const mock = await startMockUpstream({ token: UPSTREAM_TOKEN });
let gateway;
try {
  // 2. Compile, pointed at the mock.
  const spec = readFileSync(join(here, "openapi.yaml"), "utf8").replace(
    "https://api.github.example",
    mock.url,
  );
  mkdirSync(join(work, "src"), { recursive: true });
  writeFileSync(join(work, "src", "openapi.yaml"), spec);
  const workspace = join(work, "workspace");
  const bundle = join(workspace, "github");
  await run(process.execPath, [
    anvil,
    "compile",
    join(work, "src", "openapi.yaml"),
    "--manifest",
    join(here, "anvil.yaml"),
    "--out",
    bundle,
  ]);

  // 3. The harness home.
  const home = join(work, "home", "connectors");
  await run(process.execPath, [anvil, "package", "harness", bundle, "--out", join(home, "github")]);
  const grants = [{ connector: "github", operations: ["*"], mode: "read" }];
  writeFileSync(join(work, "grants.json"), JSON.stringify(grants));
  await run(process.execPath, [
    anvil,
    "connectors",
    "index",
    "--grants",
    join(work, "grants.json"),
    "--out",
    join(home, "INDEX.md"),
    bundle,
  ]);
  check("index lists github", readFileSync(join(home, "INDEX.md"), "utf8").includes("## github"));

  // 4. Keys.
  const yard = join(work, "yard");
  const { jwksPath } = keygen(yard);
  const vaultKey = join(work, "vault.key");
  writeFileSync(vaultKey, Buffer.alloc(32, 7).toString("hex"), { mode: 0o600 });
  chmodSync(vaultKey, 0o600);

  // 5. The gateway.
  const port = await freePort();
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  const auditFile = join(work, "audit.jsonl");
  const gatewayEnv = {
    ...hermetic(process.env),
    ANVIL_INBOUND_AUTH_MODE: "branchyard",
    ANVIL_INBOUND_ISSUER: ISSUER,
    ANVIL_INBOUND_AUDIENCE: mcpUrl,
    ANVIL_INBOUND_JWKS_URI: pathToFileURL(jwksPath).href,
    ANVIL_VAULT_KEY_FILE: vaultKey,
    ANVIL_VAULT_DIR: join(work, "vault"),
    ANVIL_AUDIT_FILE: auditFile,
    ANVIL_ALLOWED_HOSTS: "127.0.0.1",
  };
  gateway = spawn(
    process.execPath,
    [anvil, "serve", "mcp", workspace, "--fleet", "--http", String(port)],
    { env: gatewayEnv, stdio: ["ignore", "ignore", "pipe"] },
  );
  let gatewayLog = "";
  gateway.stderr.on("data", (chunk) => {
    gatewayLog += chunk;
  });
  await waitFor(`http://127.0.0.1:${port}/healthz`).catch((error) => {
    throw new Error(`${error.message}\n${gatewayLog}`);
  });

  const token = mint(yard, {
    iss: ISSUER,
    aud: mcpUrl,
    sub: SUB,
    by_tenant: "e2e",
    by_branch: "main",
    by_turn: "1",
    by_grants: grants,
  });
  const tokenFile = join(work, "turn.token");
  writeFileSync(tokenFile, token, { mode: 0o600 });

  // 6. Connect the person's account (a personal token, so a key connection).
  // The turn's token — the one the harness holds — cannot touch the vault.
  const byTurn = await fetch(`http://127.0.0.1:${port}/connect/api-key`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ connector: "github", api_key: "from-the-harness" }),
  });
  check("a turn token is refused at /connect/api-key", byTurn.status === 403, byTurn.status);
  await byTurn.text();
  // Only the person's connect token (`by connect` mints one) can.
  const connectFile = join(work, "connect.token");
  writeFileSync(
    connectFile,
    mint(yard, {
      iss: ISSUER,
      aud: mcpUrl,
      sub: SUB,
      by_tenant: "e2e",
      by_branch: "",
      by_turn: "",
      by_grants: [],
      by_purpose: "connect",
    }),
    { mode: 0o600 },
  );
  await run(
    process.execPath,
    [anvil, "connect", workspace, "github", "--gateway", mcpUrl, "--token-file", connectFile, "--api-key-stdin"],
    { input: `${UPSTREAM_TOKEN}\n` },
  );

  // 7. The harness, in Python, through the packaged SDK.
  const script = `
import json
from anvil_github import GithubClient, AnvilError
client = GithubClient()
issues = client.list_issue(owner="octo", repo="hello")
try:
    client.create_issue(owner="octo", repo="hello", title="nope", confirm=True)
    refused = None
except AnvilError as error:
    refused = {"code": error.code, "details": error.details}
print(json.dumps({"issues": issues, "refused": refused}))
`;
  const harnessEnv = {
    ...hermetic(process.env),
    PYTHONPATH: join(home, "github", "python"),
    ANVIL_GATEWAY_URL: mcpUrl,
    ANVIL_GATEWAY_TOKEN_FILE: tokenFile,
    // Set, and wrong: gateway mode must never read it.
    GITHUB_TOKEN: "must-not-be-read",
  };
  const harnessOut = JSON.parse((await run(python, ["-c", script], { env: harnessEnv })).trim());
  check(
    "python lists issues through the gateway",
    Array.isArray(harnessOut.issues) && harnessOut.issues.length === 2,
    harnessOut.issues,
  );
  check(
    "issues.create is refused policy_denied",
    harnessOut.refused?.code === "policy_denied" &&
      harnessOut.refused?.details?.code === "policy/grant_denied",
    harnessOut.refused,
  );

  // The packaged CLI, same gateway, same token.
  const cliOut = await run(join(home, "github", "bin", "github"), ["pulls", "list", "--owner", "octo", "--repo", "hello"], {
    env: harnessEnv,
  });
  check("bin/github lists pulls", JSON.parse(cliOut).length === 1);

  // The upstream saw only the two reads, each with the vault's token.
  const seen = mock.requests;
  check(
    "upstream saw only reads, with the connected token",
    seen.length === 2 && seen.every((r) => r.method === "GET" && r.authorized),
    seen,
  );

  // 8. Audit.
  const audit = readFileSync(auditFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const list = audit.find((line) => line.operation === "github.issues.list");
  const create = audit.find((line) => line.operation === "github.issues.create");
  check(
    "audit: issues.list allowed",
    list?.decision === "allowed" && list.upstream_status === 200 && list.sub === SUB,
    list,
  );
  check(
    "audit: issues.create denied",
    create?.decision === "denied" && create.upstream_status === null && create.by_turn === "1",
    create,
  );
  check("audit: one line per call", audit.length === 3, audit.length);

  // 9. Effects (ADR-0030), on a turn granted github:write.
  const writeGrant = [{ connector: "github", operations: ["*"], mode: "write", confirm: "allow" }];
  const writeToken = mint(yard, {
    iss: ISSUER,
    aud: mcpUrl,
    sub: SUB,
    by_tenant: "e2e",
    by_branch: "main",
    by_turn: "2",
    by_grants: writeGrant,
  });
  const mcp = await mcpSession(mcpUrl, writeToken);
  const restCall = async (tool, args, { key, stage } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/call/${tool}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${writeToken}`,
        "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: JSON.stringify({ arguments: args, ...(stage ? { stage: true } : {}) }),
    });
    const header = res.headers.get("x-anvil-effect");
    return { status: res.status, body: await res.json(), effect: header ? JSON.parse(header) : null };
  };
  const repo = { owner: "octo", repo: "hello" };

  // A reversible effect: comment, with the ledger id as the idempotency key.
  const LEDGER_ID = "01JBRANCHYARDLEDGER00000001";
  const commented = await mcp.call(
    "github__github_create_comment",
    { ...repo, issue_number: 2, body: "Looks good." },
    { idempotency_key: LEDGER_ID },
  );
  const commentEffect = commented._meta?.effect;
  check(
    "mcp: comment reports its inverse",
    !commented.isError &&
      commentEffect?.class === "reversible" &&
      commentEffect.idempotency_key === LEDGER_ID &&
      commentEffect.undo?.kind === "inverse" &&
      commentEffect.undo.tool === "github__github_delete_comment" &&
      JSON.stringify(commentEffect.undo.arguments) ===
        JSON.stringify({ owner: "octo", repo: "hello", comment_id: 100 }),
    commentEffect,
  );
  check(
    "the idempotency key reached the upstream",
    mock.requests.some(
      (r) => r.method === "POST" && r.path.endsWith("/comments") && r.idempotency_key === LEDGER_ID,
    ),
    mock.requests.filter((r) => r.method === "POST"),
  );
  // The undo is an ordinary call under the same grant, over REST here. Its
  // arguments are the report's; the confirmation a deletion needs is the
  // caller's to give, never the report's.
  const undone = await restCall(commentEffect?.undo?.tool ?? "missing", {
    ...commentEffect?.undo?.arguments,
    confirm: true,
  });
  check(
    "rest: the inverse deletes the comment under the same grant",
    undone.status === 200 && mock.state.comments.length === 0 && undone.effect?.class === "irreversible",
    { status: undone.status, body: undone.body, effect: undone.effect, comments: mock.state.comments },
  );

  // A compensable effect over REST: the report rides in X-Anvil-Effect.
  const opened = await restCall("github__github_create_issue", { ...repo, title: "From a branch", confirm: true });
  const compensation = opened.effect?.undo;
  check(
    "rest: issue reports its compensation in X-Anvil-Effect",
    opened.status === 200 &&
      opened.body?.number === 3 &&
      opened.effect?.class === "compensable" &&
      compensation?.kind === "compensate" &&
      compensation.tool === "github__github_update_issue" &&
      JSON.stringify(compensation.arguments) ===
        JSON.stringify({ owner: "octo", repo: "hello", issue_number: 3, state: "closed" }),
    opened,
  );
  const compensated = await mcp.call(compensation?.tool ?? "missing", { ...compensation?.arguments, confirm: true });
  check(
    "mcp: the compensation closes the issue",
    !compensated.isError && mock.state.issues.find((i) => i.number === 3)?.state === "closed",
    compensated,
  );

  // An irreversible effect with a draft form: stage, then promote.
  const staged = await mcp.call(
    "github__github_create_release",
    { ...repo, tag_name: "v1.0.0", name: "One", confirm: true },
    { stage: true },
  );
  const stagedEffect = staged._meta?.effect;
  const draft = mock.state.releases[0];
  check(
    "mcp: stage creates a draft and names its promotion",
    !staged.isError &&
      draft?.draft === true &&
      stagedEffect?.class === "irreversible" &&
      stagedEffect.undo === null &&
      stagedEffect.staged?.handle === draft.id &&
      stagedEffect.staged.promote?.tool === "github__github_update_release" &&
      stagedEffect.staged.promote.arguments.draft === false &&
      stagedEffect.staged.discard?.tool === "github__github_delete_release",
    { stagedEffect, releases: mock.state.releases },
  );
  const promoted = await mcp.call(stagedEffect?.staged?.promote?.tool ?? "missing", {
    ...stagedEffect?.staged?.promote?.arguments,
    confirm: true,
  });
  check(
    "mcp: promote publishes the release",
    !promoted.isError && mock.state.releases[0]?.draft === false,
    { promoted, releases: mock.state.releases },
  );

  // An operation that declares nothing gets the default: a read is `read`.
  const listed = await restCall("github__github_list_issue", repo);
  check(
    "rest: an undeclared read reports class read and no undo",
    listed.status === 200 && listed.effect?.class === "read" && listed.effect.undo === null,
    listed.effect,
  );
  await mcp.close();

  const effectAudit = readFileSync(auditFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .slice(3);
  const commentLine = effectAudit.find((line) => line.operation === "github.comments.create");
  const stagedLine = effectAudit.find((line) => line.staged_for === "github.releases.create");
  check(
    "audit: effect class and ledger id",
    commentLine?.effect_class === "reversible" &&
      commentLine.ledger_id === LEDGER_ID &&
      commentLine.by_turn === "2" &&
      stagedLine?.operation === "github.releases.create" &&
      effectAudit.every((line) => typeof line.effect_class === "string"),
    effectAudit,
  );
} finally {
  gateway?.kill("SIGTERM");
  await mock.close();
}

const ok = checks.every((c) => c.ok);
process.stdout.write(`${JSON.stringify({ ok, work, checks })}\n`);
if (!keep && ok) rmSync(work, { recursive: true, force: true });
process.exitCode = ok ? 0 : 1;
