import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { credentialProfileName, envPrefix } from "@anvil/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { runAuthLogin, runAuthStatus } from "./auth.js";

const examples = fileURLToPath(new URL("../../../../examples/payments/", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "anvil-auth-cli-"));
  dirs.push(dir);
  return dir;
}
const cleanupEnv: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of cleanupEnv.splice(0)) delete process.env[key];
});

/** IO that fires a callback for every line written — used to react to the printed authorize URL as if a human clicked it. */
function watchedIO(onLine: (line: string) => void) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (s: string) => {
      stdout.push(s);
      onLine(s);
    },
    err: (s: string) => {
      stderr.push(s);
    },
  };
}

/** A minimal fake IdP: /authorize redirects with a code, /token validates PKCE and returns tokens. */
function fakeIdp(opts: {
  expectClientId: string;
  expectClientSecret?: string;
  refreshToken?: string;
  omitRefreshToken?: boolean;
}): Promise<{ server: Server; base: string }> {
  const codeChallenges = new Map<string, string>();
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/authorize") {
        const state = url.searchParams.get("state") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const challenge = url.searchParams.get("code_challenge") ?? "";
        const code = "test-auth-code";
        codeChallenges.set(code, challenge);
        const target = new URL(redirectUri);
        target.searchParams.set("code", code);
        target.searchParams.set("state", state);
        res.writeHead(302, { location: target.toString() });
        res.end();
        return;
      }
      if (url.pathname === "/token") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const code = body.get("code") ?? "";
        const verifier = body.get("code_verifier") ?? "";
        const challenge = codeChallenges.get(code);
        const computed = createHash("sha256").update(verifier).digest("base64url");
        const authHeader = req.headers.authorization;
        const clientIdOk = authHeader
          ? authHeader ===
            `Basic ${Buffer.from(`${opts.expectClientId}:${opts.expectClientSecret ?? ""}`).toString("base64")}`
          : body.get("client_id") === opts.expectClientId;
        if (challenge !== computed || !clientIdOk) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "test-access-token",
            expires_in: 3600,
            ...(opts.omitRefreshToken
              ? {}
              : { refresh_token: opts.refreshToken ?? "test-refresh-token" }),
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function compiledBundle(manifest: string): Promise<{ dir: string; air: AirDocument }> {
  const air = await compile({ spec: read("openapi.yaml"), manifest, serviceId: "payments" });
  const dir = freshDir();
  writeBundle(dir, generateBundle(air));
  return { dir, air };
}

describe("anvil auth login", () => {
  it("completes the PKCE flow against a real local IdP and stores a refresh token, mode 0600", async () => {
    const idp = await fakeIdp({ expectClientId: "client-1", expectClientSecret: "shh" });
    try {
      const { dir, air } = await compiledBundle(`
operations:
  createRefund:
    auth:
      type: oauth2_authorization_code
      credential_profile: end_user_flow
      provider:
        authorization_endpoint: ${idp.base}/authorize
        token_endpoint: ${idp.base}/token
        redirect_uri: http://127.0.0.1:0/callback
        pkce: true
`);
      const op =
        air.operations.find((o) => o.canonicalName === "create_refund") ?? air.operations[0];
      if (!op) throw new Error("fixture: no operation compiled");
      const profileName = credentialProfileName("test", op.auth);
      const prefix = envPrefix(profileName);
      process.env[`${prefix}_CLIENT_ID`] = "client-1";
      process.env[`${prefix}_CLIENT_SECRET`] = "shh";
      cleanupEnv.push(`${prefix}_CLIENT_ID`, `${prefix}_CLIENT_SECRET`);

      const credDir = freshDir();
      const io = watchedIO((line) => {
        const match = /^ {2}(http:\/\/[^\s]+)$/.exec(line);
        if (match?.[1]) void fetch(match[1]);
      });

      const code = await runAuthLogin(dir, { profile: "test", timeoutSeconds: "10" }, io, credDir);

      expect(code).toBe(0);
      const filePath = join(credDir, `${profileName}.json`);
      expect(existsSync(filePath)).toBe(true);
      const stored = JSON.parse(readFileSync(filePath, "utf8"));
      expect(stored.refresh_token).toBe("test-refresh-token");
      expect(typeof stored.obtained_at).toBe("string");
      // Never printed anywhere, including stdout/stderr.
      expect(io.stdout.join(" ")).not.toContain("test-refresh-token");
      expect(io.stderr.join(" ")).not.toContain("test-refresh-token");
      // mode 0600 — owner read/write only.
      const mode = statSync(filePath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      idp.server.close();
    }
  });

  it("fails, never storing anything, when the IdP returns no refresh_token", async () => {
    const idp = await fakeIdp({ expectClientId: "client-1", omitRefreshToken: true });
    try {
      const { dir, air } = await compiledBundle(`
operations:
  createRefund:
    auth:
      type: oauth2_authorization_code
      credential_profile: end_user_flow
      provider:
        authorization_endpoint: ${idp.base}/authorize
        token_endpoint: ${idp.base}/token
        redirect_uri: http://127.0.0.1:0/callback
`);
      const op =
        air.operations.find((o) => o.canonicalName === "create_refund") ?? air.operations[0];
      if (!op) throw new Error("fixture: no operation compiled");
      const profileName = credentialProfileName("test", op.auth);
      const prefix = envPrefix(profileName);
      process.env[`${prefix}_CLIENT_ID`] = "client-1";
      cleanupEnv.push(`${prefix}_CLIENT_ID`);

      const credDir = freshDir();
      const io = watchedIO((line) => {
        const match = /^ {2}(http:\/\/[^\s]+)$/.exec(line);
        if (match?.[1]) void fetch(match[1]);
      });
      const code = await runAuthLogin(dir, { profile: "test", timeoutSeconds: "10" }, io, credDir);
      expect(code).toBe(1);
      expect(io.stderr.join(" ")).toContain("did not return a refresh_token");
      expect(existsSync(join(credDir, `${profileName}.json`))).toBe(false);
    } finally {
      idp.server.close();
    }
  });

  it("refuses without ever contacting the network when *_CLIENT_ID is unset", async () => {
    const { dir } = await compiledBundle(`
operations:
  createRefund:
    auth:
      type: oauth2_authorization_code
      credential_profile: end_user_flow
      provider:
        authorization_endpoint: http://127.0.0.1:1/authorize
        token_endpoint: http://127.0.0.1:1/token
`);
    const io = watchedIO(() => {
      throw new Error("must not print an authorize URL without a client id");
    });
    const code = await runAuthLogin(dir, { profile: "test", timeoutSeconds: "1" }, io, freshDir());
    expect(code).toBe(1);
    expect(io.stderr.join(" ")).toContain("CLIENT_ID");
  });

  it("refuses when the bundle has no oauth2_authorization_code operation", async () => {
    const { dir } = await compiledBundle("");
    const io = watchedIO(() => {});
    const code = await runAuthLogin(dir, { profile: "test", timeoutSeconds: "1" }, io, freshDir());
    expect(code).toBe(1);
    expect(io.stderr.join(" ")).toContain("No oauth2_authorization_code operation");
  });
});

describe("anvil auth status", () => {
  it("reports material present (names only, never values) once a refresh token is stored", async () => {
    const { dir, air } = await compiledBundle(`
operations:
  createRefund:
    auth:
      type: oauth2_authorization_code
      credential_profile: end_user_flow
      provider:
        authorization_endpoint: http://127.0.0.1:1/authorize
        token_endpoint: http://127.0.0.1:1/token
`);
    const op = air.operations.find((o) => o.canonicalName === "create_refund") ?? air.operations[0];
    if (!op) throw new Error("fixture: no operation compiled");
    const profileName = credentialProfileName("test", op.auth);
    const credDir = freshDir();

    const before = watchedIO(() => {});
    expect(runAuthStatus(dir, { profile: "test" }, before, credDir)).toBe(0);
    expect(before.stdout.join(" ")).toContain("material present: no");

    // Simulate a completed `anvil auth login` by writing the stored-token file directly.
    const { mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
    mkdirSync(credDir, { recursive: true });
    const filePath = join(credDir, `${profileName}.json`);
    writeFileSync(filePath, JSON.stringify({ refresh_token: "secret-value" }));
    chmodSync(filePath, 0o600);

    const after = watchedIO(() => {});
    expect(runAuthStatus(dir, { profile: "test" }, after, credDir)).toBe(0);
    expect(after.stdout.join(" ")).toContain("material present: yes");
    expect(after.stdout.join(" ")).toContain("stored refresh token found");
    // Never the secret value itself.
    expect(after.stdout.join(" ")).not.toContain("secret-value");
  });

  it("emits machine-readable JSON with --json", async () => {
    const { dir } = await compiledBundle("");
    const io = watchedIO(() => {});
    expect(runAuthStatus(dir, { profile: "test", json: true }, io, freshDir())).toBe(0);
    const parsed = JSON.parse(io.stdout.join("\n"));
    expect(parsed.service).toBe("payments");
    expect(Array.isArray(parsed.rows)).toBe(true);
  });
});
