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
// 6. connects the person's account with `anvil connect --api-key-stdin`;
// 7. with a token granting github:read, lists issues through the packaged
//    Python SDK in gateway mode (GITHUB_TOKEN is set to a wrong value and
//    must not be read), and asks for issues.create, which must be refused
//    policy_denied without reaching the upstream;
// 8. checks the audit log has exactly those two lines.
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
  await run(
    process.execPath,
    [anvil, "connect", workspace, "github", "--gateway", mcpUrl, "--token-file", tokenFile, "--api-key-stdin"],
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
} finally {
  gateway?.kill("SIGTERM");
  await mock.close();
}

const ok = checks.every((c) => c.ok);
process.stdout.write(`${JSON.stringify({ ok, work, checks })}\n`);
if (!keep && ok) rmSync(work, { recursive: true, force: true });
process.exitCode = ok ? 0 : 1;
