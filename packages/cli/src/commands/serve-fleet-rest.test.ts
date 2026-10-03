import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";
import { type FleetHttpHandle, startFleetHttp } from "./serve-fleet-http.js";

/**
 * `POST /call/<tool>` on the Branchyard gateway (ADR-0030): the same
 * principal, grant, and executor as `/mcp`, the `Idempotency-Key` header
 * forwarded through the operation's carrier, and the effect report in
 * `X-Anvil-Effect`. Driven against the github-mini fixture and its mock
 * upstream, over real sockets.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../../examples/github-mini/${name}`, import.meta.url));

interface Mock {
  url: string;
  requests: Array<{ method: string; path: string; idempotency_key?: string }>;
  state: { comments: unknown[]; releases: Array<{ id: number; draft: boolean }> };
  close(): Promise<void>;
}

let root: string;
let mock: Mock;
let gateway: FleetHttpHandle;
let base: string;
let mint: (grants: unknown[], extra?: Record<string, unknown>) => string;
let auditFile: string;
const ISSUER = "branchyard:local:rest";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "anvil-rest-"));
  const { startMockUpstream } = (await import(
    pathToFileURL(fixture("mock-upstream.mjs")).href
  )) as {
    startMockUpstream(options: { token: string }): Promise<Mock>;
  };
  const keys = (await import(pathToFileURL(fixture("yard-keys.mjs")).href)) as {
    keygen(dir: string): { jwksPath: string };
    mint(dir: string, claims: Record<string, unknown>): string;
  };
  mock = await startMockUpstream({ token: "pat" });
  const spec = join(root, "openapi.yaml");
  writeFileSync(
    spec,
    readFileSync(fixture("openapi.yaml"), "utf8").replace("https://api.github.example", mock.url),
  );
  const workspace = join(root, "workspace");
  const io = bufferIO();
  const compiled = await runAnvilCli(
    ["compile", spec, "--manifest", fixture("anvil.yaml"), "--out", join(workspace, "github")],
    { io },
  );
  expect(compiled, io.stderr.join("\n")).toBe(0);

  const yard = join(root, "yard");
  const { jwksPath } = keys.keygen(yard);
  const vaultKey = join(root, "vault.key");
  writeFileSync(vaultKey, Buffer.alloc(32, 9).toString("hex"), { mode: 0o600 });
  auditFile = join(root, "audit.jsonl");
  // Bind first to learn the port the audience must name.
  const probe = await startFleetHttp(workspace, {
    host: "127.0.0.1",
    port: 0,
    env: { ANVIL_ALLOWED_HOSTS: "127.0.0.1" },
    io: bufferIO(),
  });
  if (!probe.ok) throw new Error(probe.message);
  const port = probe.handle.port;
  await probe.handle.close();
  base = `http://127.0.0.1:${port}`;
  const audience = `${base}/mcp`;
  const env = {
    ANVIL_INBOUND_AUTH_MODE: "branchyard",
    ANVIL_INBOUND_ISSUER: ISSUER,
    ANVIL_INBOUND_AUDIENCE: audience,
    ANVIL_INBOUND_JWKS_URI: pathToFileURL(jwksPath).href,
    ANVIL_VAULT_KEY_FILE: vaultKey,
    ANVIL_VAULT_DIR: join(root, "vault"),
    ANVIL_AUDIT_FILE: auditFile,
    ANVIL_ALLOWED_HOSTS: "127.0.0.1",
  };
  const started = await startFleetHttp(workspace, {
    host: "127.0.0.1",
    port,
    env,
    io: bufferIO(),
  });
  if (!started.ok) throw new Error(started.message);
  gateway = started.handle;
  mint = (grants, extra = {}) =>
    keys.mint(yard, {
      iss: ISSUER,
      aud: audience,
      sub: "local:rest-person",
      by_tenant: "t",
      by_branch: "main",
      by_turn: "1",
      by_grants: grants,
      ...extra,
    });
  const connected = await fetch(`${base}/connect/api-key`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mint([], { by_branch: "", by_turn: "", by_purpose: "connect" })}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ connector: "github", api_key: "pat" }),
  });
  expect(connected.status).toBe(200);
}, 120_000);

afterAll(async () => {
  await gateway?.close();
  await mock?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

const WRITE = [{ connector: "github", operations: ["*"], mode: "write", confirm: "allow" }];
const READ = [{ connector: "github", operations: ["*"], mode: "read" }];

async function call(
  token: string,
  tool: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  body: Record<string, unknown>;
  effect: Record<string, unknown> | null;
}> {
  const res = await fetch(`${base}/call/${tool}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const effect = res.headers.get("x-anvil-effect");
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    effect: effect ? (JSON.parse(effect) as Record<string, unknown>) : null,
  };
}

const repo = { owner: "octo", repo: "hello" };

describe("POST /call/<tool>", () => {
  it("forwards Idempotency-Key, reports the inverse, and runs it under the same grant", async () => {
    const token = mint(WRITE);
    const created = await call(
      token,
      "github__github_create_comment",
      { arguments: { ...repo, issue_number: 2, body: "LGTM ✓" } },
      { "idempotency-key": "01JLEDGERREST0000000000001" },
    );
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ body: "LGTM ✓" });
    expect(created.effect).toMatchObject({
      class: "reversible",
      idempotency_key: "01JLEDGERREST0000000000001",
      undo: {
        kind: "inverse",
        operation: "github.comments.delete",
        tool: "github__github_delete_comment",
        arguments: { ...repo, comment_id: created.body.id },
      },
      deadline_ms: null,
    });
    expect(
      mock.requests.find((r) => r.method === "POST" && r.path.endsWith("/comments"))
        ?.idempotency_key,
    ).toBe("01JLEDGERREST0000000000001");

    // A retry with the same key is the same comment, not a second one.
    const retried = await call(
      token,
      "github__github_create_comment",
      { arguments: { ...repo, issue_number: 2, body: "LGTM ✓" } },
      { "idempotency-key": "01JLEDGERREST0000000000001" },
    );
    expect(retried.body.id).toBe(created.body.id);
    expect(mock.state.comments).toHaveLength(1);

    const undo = created.effect?.undo as { tool: string; arguments: Record<string, unknown> };
    const undone = await call(token, undo.tool, {
      arguments: { ...undo.arguments, confirm: true },
    });
    expect(undone.status).toBe(200);
    expect(undone.effect).toMatchObject({ class: "irreversible", undo: null });
    expect(mock.state.comments).toHaveLength(0);
  });

  it("keeps the header ASCII when arguments are not", async () => {
    const res = await fetch(`${base}/call/github__github_create_comment`, {
      method: "POST",
      headers: { authorization: `Bearer ${mint(WRITE)}`, "content-type": "application/json" },
      body: JSON.stringify({
        arguments: { owner: "\u00f8cto", repo: "h\u00e9llo", issue_number: 1, body: "x" },
      }),
    });
    expect(res.status).toBe(200);
    const header = res.headers.get("x-anvil-effect") ?? "";
    expect(/^[\x20-\x7e]*$/.test(header)).toBe(true);
    expect(JSON.parse(header).undo.arguments).toMatchObject({
      owner: "\u00f8cto",
      repo: "h\u00e9llo",
    });
  });

  it("refuses an inverse the grant does not allow, without reaching the upstream", async () => {
    const before = mock.requests.length;
    const refused = await call(mint(READ), "github__github_delete_comment", {
      arguments: { ...repo, comment_id: 100, confirm: true },
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      error: { code: "policy_denied", details: { code: "policy/grant_denied" } },
    });
    expect(refused.effect).toMatchObject({ class: "irreversible", undo: null });
    expect(mock.requests.length).toBe(before);
  });

  it("stages a release as a draft and promotes it", async () => {
    const token = mint(WRITE);
    const staged = await call(token, "github__github_create_release", {
      arguments: { ...repo, tag_name: "v9", confirm: true },
      stage: true,
    });
    expect(staged.status).toBe(200);
    const release = mock.state.releases.find((r) => r.id === staged.body.id);
    expect(release?.draft).toBe(true);
    const promote = (
      staged.effect?.staged as { promote: { tool: string; arguments: object } } | undefined
    )?.promote ?? { tool: "missing", arguments: {} };
    expect(promote.tool).toBe("github__github_update_release");
    const promoted = await call(token, promote.tool, {
      arguments: { ...promote.arguments, confirm: true },
    });
    expect(promoted.status).toBe(200);
    expect(release?.draft).toBe(false);
  });

  it("answers the default class for an undeclared read", async () => {
    const listed = await call(mint(READ), "github__github_list_issue", { arguments: repo });
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.body)).toBe(true);
    expect(listed.effect).toMatchObject({ class: "read", undo: null, idempotency_key: null });
  });

  it("refuses a bad request before any tool runs", async () => {
    const token = mint(WRITE);
    expect((await call(token, "github__nope", { arguments: {} })).status).toBe(404);
    expect((await call(token, "github__github_list_issue", "[1]")).status).toBe(400);
    expect(
      (await call(token, "github__github_list_issue", { arguments: repo, stage: "yes" })).status,
    ).toBe(400);
    const invalid = await call(token, "github__github_list_issue", { arguments: { owner: 1 } });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ error: { code: "validation_error" } });
    const anonymous = await fetch(`${base}/call/github__github_list_issue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: repo }),
    });
    expect(anonymous.status).toBe(401);
  });

  it("writes the effect class and ledger id on the audit line", () => {
    const lines = readFileSync(auditFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.find((line) => line.operation === "github.comments.create")).toMatchObject({
      effect_class: "reversible",
      ledger_id: "01JLEDGERREST0000000000001",
      staged_for: null,
    });
    expect(lines.find((line) => line.staged_for === "github.releases.create")).toMatchObject({
      operation: "github.releases.create",
      effect_class: "irreversible",
    });
  });
});
