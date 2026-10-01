import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Operation, Operation as OperationSchema } from "@anvil/air";
import { afterEach, describe, expect, it } from "vitest";
import { type AuditLine, fileAuditSink, redactedInputHash, redactInput } from "./audit.js";
import { execute } from "./executor.js";
import type { GrantEntry } from "./grants.js";
import type { Principal } from "./policy.js";
import { MockTransport } from "./transport.js";
import { ConnectionVault, VaultCredentialResolver } from "./vault.js";

/**
 * The Branchyard gateway's hot-path gates (ADR-0029): a granted principal is
 * checked per operation before any upstream call, its credential comes from
 * its own vault connection, and every call leaves one audit line.
 */

function op(id: string, kind: "read" | "mutation", confirm = false): Operation {
  return OperationSchema.parse({
    id,
    canonicalName: id.replace(/\./g, "_"),
    displayName: id,
    sourceRef: {
      kind: "openapi",
      path: "/repos/{owner}/issues",
      method: kind === "read" ? "get" : "post",
    },
    effect: {
      kind,
      action: kind === "read" ? "list" : "create",
      resource: "issue",
      risk: kind === "read" ? "low" : "medium",
      reversible: false,
    },
    input: {
      params: [{ name: "owner", in: "path", required: true, schema: { type: "string" } }],
    },
    idempotency: { mode: kind === "read" ? "natural" : "none", mechanism: "none" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: confirm },
    auth: { type: "jwt_bearer", scopes: [] },
    cli: { command: `github ${id}` },
    mcp: { toolName: id.replace(/\./g, "_") },
    skill: { intentExamples: [] },
    state: "approved",
  });
}

const list = op("github.issues.list", "read");
const create = op("github.issues.create", "mutation", true);
const ok = () => ({ status: 200, headers: {}, body: "[]" });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "anvil-branchyard-"));
  dirs.push(dir);
  return dir;
}

function principal(grants: GrantEntry[]): Principal {
  return {
    id: "local:ada",
    scopes: ["*"],
    grants,
    attribution: { tenant: "t1", branch: "feature-x", turn: "7" },
  };
}

function harness(grants: GrantEntry[]) {
  const dir = tmp();
  const vault = new ConnectionVault(join(dir, "vault"), Buffer.alloc(32, 3));
  const lines: AuditLine[] = [];
  const transport = new MockTransport(ok);
  const ctx = {
    serviceId: "github",
    baseUrl: "https://api.github.example",
    allowedHosts: ["api.github.example"],
    env: "dev" as const,
    sleep: async () => {},
    transport,
    connector: "github",
    principal: principal(grants),
    credentials: new VaultCredentialResolver(vault, () => undefined),
    audit: (line: AuditLine) => lines.push(line),
  };
  return { vault, lines, transport, ctx };
}

function connect(vault: ConnectionVault, account = "default", secret = "pat-123") {
  const stamp = new Date().toISOString();
  vault.put({
    sub: "local:ada",
    connector: "github",
    account,
    kind: "static",
    status: "active",
    secret,
    createdAt: stamp,
    updatedAt: stamp,
  });
}

describe("the grant gate", () => {
  it("allows a granted read with the person's own connected token and audits it", async () => {
    const h = harness([{ connector: "github", operations: ["issues.*"], mode: "read" }]);
    connect(h.vault);
    const res = await execute(list, { input: { owner: "octo" } }, h.ctx);
    expect(res.outcome).toBe("success");
    expect(h.transport.requests).toHaveLength(1);
    expect(h.transport.requests[0]?.headers.Authorization).toBe("Bearer pat-123");
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toMatchObject({
      sub: "local:ada",
      by_tenant: "t1",
      by_branch: "feature-x",
      by_turn: "7",
      connector: "github",
      account: "default",
      operation: "github.issues.list",
      decision: "allowed",
      grant: { index: 0, connector: "github", operations: ["issues.*"], mode: "read" },
      upstream_status: 200,
      error_code: null,
    });
    expect(h.lines[0]?.input_sha256).toBe(redactedInputHash({ owner: "octo" }));
  });

  it("uses the account the matching entry names", async () => {
    const h = harness([{ connector: "github", operations: ["*"], mode: "read", account: "work" }]);
    connect(h.vault, "default", "personal-token");
    connect(h.vault, "work", "work-token");
    await execute(list, { input: { owner: "octo" } }, h.ctx);
    expect(h.transport.requests[0]?.headers.Authorization).toBe("Bearer work-token");
    expect(h.lines[0]?.account).toBe("work");
  });

  it("denies an ungranted connector with policy_denied naming the rule, and sends nothing", async () => {
    const h = harness([{ connector: "slack", operations: ["*"], mode: "write" }]);
    connect(h.vault);
    const res = await execute(list, { input: { owner: "octo" } }, h.ctx);
    if (res.outcome !== "error") throw new Error("expected a refusal");
    expect(res.envelope.error.code).toBe("policy_denied");
    expect(res.envelope.error.details).toMatchObject({
      code: "policy/grant_denied",
      connector: "github",
      rule: null,
    });
    expect(h.transport.requests).toHaveLength(0);
    expect(h.lines[0]).toMatchObject({
      decision: "denied",
      rule: "policy/grant_denied",
      upstream_status: null,
    });
  });

  it("denies a mutation under a read grant with the stopping entry, and sends nothing", async () => {
    const h = harness([{ connector: "github", operations: ["*"], mode: "read" }]);
    connect(h.vault);
    const res = await execute(create, { input: { owner: "octo" }, confirm: true }, h.ctx);
    if (res.outcome !== "error") throw new Error("expected a refusal");
    expect(res.envelope.error.code).toBe("policy_denied");
    expect(res.envelope.error.message).toContain("read-only");
    expect(res.envelope.error.details).toMatchObject({
      rule: { index: 0, connector: "github", mode: "read" },
    });
    expect(h.transport.requests).toHaveLength(0);
    expect(h.lines[0]?.decision).toBe("denied");
  });

  it("denies an operation the globs do not name", async () => {
    const h = harness([{ connector: "github", operations: ["pulls.*"], mode: "write" }]);
    const res = await execute(list, { input: { owner: "octo" } }, h.ctx);
    if (res.outcome !== "error") throw new Error("expected a refusal");
    expect(res.envelope.error.code).toBe("policy_denied");
    expect(res.envelope.error.message).toContain("names operation 'github.issues.list'");
  });

  it("refuses a confirmation-gated mutation with confirmation_required unless the entry allows it", async () => {
    const h = harness([{ connector: "github", operations: ["*"], mode: "write" }]);
    connect(h.vault);
    const res = await execute(create, { input: { owner: "octo" }, confirm: true }, h.ctx);
    if (res.outcome !== "error") throw new Error("expected a refusal");
    expect(res.envelope.error.code).toBe("confirmation_required");
    expect(res.envelope.error.details).toMatchObject({
      code: "policy/grant_confirmation_required",
    });
    expect(h.transport.requests).toHaveLength(0);
    expect(h.lines[0]?.decision).toBe("confirmation_required");

    const allowed = harness([
      { connector: "github", operations: ["*"], mode: "write", confirm: "allow" },
    ]);
    connect(allowed.vault);
    const done = await execute(create, { input: { owner: "octo" }, confirm: true }, allowed.ctx);
    expect(done.outcome).toBe("success");
    expect(allowed.transport.requests).toHaveLength(1);
  });

  it("still requires the caller's own confirm when the entry allows confirmation", async () => {
    const h = harness([
      { connector: "github", operations: ["*"], mode: "write", confirm: "allow" },
    ]);
    connect(h.vault);
    const res = await execute(create, { input: { owner: "octo" } }, h.ctx);
    if (res.outcome !== "error") throw new Error("expected a refusal");
    expect(res.envelope.error.code).toBe("confirmation_required");
    expect(res.envelope.error.details).toBeUndefined();
    expect(h.transport.requests).toHaveLength(0);
  });

  it("names the connector, never a link, when the account is not connected", async () => {
    const h = harness([{ connector: "github", operations: ["*"], mode: "read", account: "work" }]);
    const res = await execute(list, { input: { owner: "octo" } }, h.ctx);
    if (res.outcome !== "error") throw new Error("expected a refusal");
    expect(res.envelope.error.code).toBe("auth_required");
    expect(res.envelope.error.details).toEqual({
      code: "connector/not_connected",
      connector: "github",
      account: "work",
    });
    expect(res.envelope.error.message).toContain("Connector 'github'");
    expect(res.envelope.error.message).not.toMatch(/https?:\/\//);
    expect(h.transport.requests).toHaveLength(0);
  });

  it("dry-runs a granted call without resolving a credential", async () => {
    const h = harness([{ connector: "github", operations: ["*"], mode: "read" }]);
    const res = await execute(list, { input: { owner: "octo" }, dryRun: true }, h.ctx);
    expect(res.outcome).toBe("dry_run");
    expect(h.lines[0]).toMatchObject({ decision: "allowed", dry_run: true, upstream_status: null });
  });

  it("leaves a principal without a grant exactly as before", async () => {
    const transport = new MockTransport(ok);
    const res = await execute(
      list,
      { input: { owner: "octo" } },
      {
        serviceId: "github",
        baseUrl: "https://api.github.example",
        allowedHosts: ["api.github.example"],
        env: "dev",
        transport,
        principal: { id: "alice", scopes: ["*"] },
        credentials: { resolve: async () => ({ headers: { Authorization: "Bearer env" } }) },
      },
    );
    expect(res.outcome).toBe("success");
    expect(transport.requests[0]?.headers.Authorization).toBe("Bearer env");
  });
});

describe("the audit log", () => {
  it("redacts credential-looking keys before hashing", () => {
    expect(
      redactInput({ title: "x", api_key: "secret", nested: [{ password: "p", ok: 1 }] }),
    ).toEqual({
      title: "x",
      api_key: "***",
      nested: [{ password: "***", ok: 1 }],
    });
    expect(redactedInputHash({ title: "x", token: "a" })).toBe(
      redactedInputHash({ token: "b", title: "x" }),
    );
    expect(redactedInputHash({ title: "x" })).not.toBe(redactedInputHash({ title: "y" }));
  });

  it("appends one JSON line per call to a 0600 file", async () => {
    const dir = tmp();
    const file = join(dir, "audit.jsonl");
    const h = harness([{ connector: "github", operations: ["*"], mode: "read" }]);
    connect(h.vault);
    const ctx = { ...h.ctx, audit: fileAuditSink(file) };
    await execute(list, { input: { owner: "octo" } }, ctx);
    await execute(create, { input: { owner: "octo" }, confirm: true }, ctx);
    const lines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => [line.operation, line.decision])).toEqual([
      ["github.issues.list", "allowed"],
      ["github.issues.create", "denied"],
    ]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain("pat-123");
  });

  it("never fails a call when the sink cannot write", async () => {
    const dir = tmp();
    const sub = join(dir, "logs");
    mkdirSync(sub);
    const errors: string[] = [];
    const sink = fileAuditSink(join(sub, "audit.jsonl"), (message) => errors.push(message));
    rmSync(sub, { recursive: true, force: true });
    const h = harness([{ connector: "github", operations: ["*"], mode: "read" }]);
    connect(h.vault);
    const res = await execute(list, { input: { owner: "octo" } }, { ...h.ctx, audit: sink });
    expect(res.outcome).toBe("success");
    expect(errors).toHaveLength(1);
  });
});
