import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AirDocument, Operation } from "@anvil/air";
import { loadAir } from "@anvil/refinement";
import { credentialProfileName, credentialRequirement, envPrefix } from "@anvil/runtime";
import type { Command } from "commander";
import { emitRefusal } from "../envelope.js";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil auth login` / `anvil auth status` — the interactive PKCE broker
 * (RFC 6749 §4.1, PKCE per RFC 7636) that lets an operator complete an
 * `oauth2_authorization_code` operation's ONE interactive step once, on their
 * own machine, and store a refresh token the deployed runtime replays or
 * refreshes per call (packages/runtime/src/auth.ts's `EnvCredentialResolver`,
 * `FileRefreshTokenSource`). Never in the serving path; never prints or logs
 * the token it stores.
 */
export function registerAuth(parent: Command, ctx: CommandContext): void {
  const auth = annotate(
    parent
      .command("auth")
      .summary("Complete the interactive step for end-user (authorization-code) auth."),
    { mutates: false },
  );

  annotate(
    auth
      .command("login")
      .summary("Run the PKCE authorization-code flow once and store a refresh token.")
      .description(
        "Finds the bundle's oauth2_authorization_code operation (--operation disambiguates when more than one distinct shape is declared), prints the authorization URL (--open launches the default browser), listens on its declared loopback redirect_uri (127.0.0.1, a random port when none is declared), exchanges the returned code at token_endpoint, and writes { refresh_token, obtained_at } to ~/.anvil/credentials/<profile>.json with mode 0600 — never inside the bundle, never printed. The runtime's env resolver reads it back when *_REFRESH_TOKEN is unset. Requires ANVIL_<PROFILE>_CLIENT_ID in the environment (and *_CLIENT_SECRET if the provider needs one); neither is ever echoed.",
      )
      .argument("<dir>", "generated bundle directory or air.yaml")
      .requiredOption(
        "--profile <profile>",
        "deployment profile (e.g. prod), combined with the operation's credential profile the same way the runtime combines them",
      )
      .option(
        "--operation <id>",
        "which oauth2_authorization_code operation's provider mechanics to use, when the bundle declares more than one distinct shape",
      )
      .option("--open", "open the authorization URL in the default browser")
      .option("--timeout-seconds <n>", "how long to wait for the redirect", "300")
      .action(async (dir: string, opts: AuthLoginCliOptions) => {
        ctx.code = await runAuthLogin(dir, opts, ctx.io);
      }),
    { mutates: true },
  );

  annotate(
    auth
      .command("status")
      .summary("List credential profiles in a bundle and whether material is present (names only).")
      .description(
        "Never prints a credential value — only env var NAMES and whether they (or, for oauth2_authorization_code, a stored refresh token) are present.",
      )
      .argument("<dir>", "generated bundle directory or air.yaml")
      .option("--profile <profile>", "deployment profile to resolve against", "default")
      .option("--json", "emit the full result as JSON")
      .action((dir: string, opts: AuthStatusCliOptions) => {
        ctx.code = runAuthStatus(dir, opts, ctx.io);
      }),
    { mutates: false },
  );
}

interface AuthLoginCliOptions {
  profile: string;
  operation?: string;
  open?: boolean;
  timeoutSeconds: string;
}

interface AuthStatusCliOptions {
  profile: string;
  json?: boolean;
}

/**
 * The directory the broker writes to and the resolver reads from — never
 * inside a bundle. Overridable so tests never touch a real operator's
 * `~/.anvil/credentials`; production callers always take the default.
 */
function credentialsDir(override?: string): string {
  return override ?? join(homedir(), ".anvil", "credentials");
}

function findAuthCodeOperation(
  air: AirDocument,
  ref: string | undefined,
  io: CliIO,
): Operation | undefined {
  const candidates = air.operations.filter((op) => op.auth.type === "oauth2_authorization_code");
  if (candidates.length === 0) {
    io.err(`No oauth2_authorization_code operation in '${air.service.id}'.`);
    return undefined;
  }
  if (ref) {
    const found = candidates.find(
      (op) =>
        op.id === ref ||
        op.canonicalName === ref ||
        op.cli.command === ref ||
        op.mcp.toolName === ref,
    );
    if (!found) {
      io.err(`No oauth2_authorization_code operation matches "${ref}".`);
    }
    return found;
  }
  // Distinct by (credentialProfile, provider mechanics): most estates declare
  // authorization-code on every operation of one security scheme, so this is
  // one group in practice — only ask the operator to pick when it is not.
  const shapeKey = (op: Operation) =>
    JSON.stringify([op.auth.credentialProfile, op.auth.provider ?? null]);
  const distinct = new Map<string, Operation>();
  for (const op of candidates) distinct.set(shapeKey(op), op);
  if (distinct.size > 1) {
    io.err(
      `${distinct.size} distinct oauth2_authorization_code shapes in '${air.service.id}'; pass --operation <id> to pick one:`,
    );
    for (const op of candidates) io.err(`  - ${op.id}`);
    return undefined;
  }
  return candidates[0];
}

/** The loopback the broker listens on: the declared redirect_uri's host/path, its port when named, else a random one. */
function loopbackTarget(declared: string | undefined): { path: string; port: number } {
  const url = new URL(declared ?? "http://127.0.0.1/callback");
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(
      `provider.redirect_uri must be a loopback address (127.0.0.1 or localhost); got "${url.hostname}".`,
    );
  }
  return { path: url.pathname || "/callback", port: url.port ? Number(url.port) : 0 };
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/** Open the default browser through the platform's own opener; failure is a note, never an error. */
function openBrowser(url: string, io: CliIO): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command as string, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () =>
      io.err(`  (could not open a browser with ${command}; open the URL yourself)`),
    );
    child.unref();
  } catch {
    io.err(`  (could not open a browser with ${command}; open the URL yourself)`);
  }
}

/** Wait for the redirect on a loopback HTTP server; resolves once, closes the server either way. */
function awaitRedirect(
  path: string,
  port: number,
  expectedState: string,
  timeoutMs: number,
  onListening: (actualPort: number) => void,
): Promise<{ code: string } | { error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { code: string } | { error: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      resolve(result);
    };
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== path) {
        res.writeHead(404);
        res.end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const ok = !error && code && state === expectedState;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        ok
          ? "<html><body><h1>Authorization complete</h1><p>You may close this tab and return to the terminal.</p></body></html>"
          : `<html><body><h1>Authorization failed</h1><p>${escapeHtml(error ?? "state mismatch")}</p><p>You may close this tab.</p></body></html>`,
      );
      if (error) finish({ error });
      else if (state !== expectedState) finish({ error: "state_mismatch" });
      else if (code) finish({ code });
      else finish({ error: "no_code" });
    });
    server.on("error", (err) => finish({ error: err.message }));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      onListening(typeof address === "object" && address ? address.port : port);
    });
    const timer = setTimeout(() => finish({ error: "timeout" }), timeoutMs);
    timer.unref?.();
  });
}

async function exchangeCode(
  tokenEndpoint: string,
  fields: Record<string, string>,
  clientId: string,
  clientSecret: string | undefined,
  method: "client_secret_basic" | "client_secret_post" | "private_key_jwt" | undefined,
): Promise<{
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}> {
  const body = new URLSearchParams(fields);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (clientSecret && method === "client_secret_post") {
    body.set("client_id", clientId);
    body.set("client_secret", clientSecret);
  } else if (clientSecret) {
    // Default client_secret_basic. private_key_jwt is not supported by this
    // interactive broker — only the two client-secret methods are.
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_id", clientId);
  }
  const res = await fetch(tokenEndpoint, { method: "POST", headers, body: body.toString() });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      error: typeof json.error === "string" ? json.error : `http_${res.status}`,
      error_description:
        typeof json.error_description === "string" ? json.error_description : undefined,
    };
  }
  return {
    access_token: typeof json.access_token === "string" ? json.access_token : undefined,
    refresh_token: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
  };
}

/** Exported for tests, which pass `credentialsDirOverride` to avoid touching a real `~/.anvil`. */
export async function runAuthLogin(
  dir: string,
  opts: AuthLoginCliOptions,
  io: CliIO,
  credentialsDirOverride?: string,
): Promise<number> {
  let air: AirDocument;
  try {
    air = loadAir(dir);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const op = findAuthCodeOperation(air, opts.operation, io);
  if (!op) return 1;

  const provider = op.auth.provider;
  if (!provider?.authorizationEndpoint || !provider.tokenEndpoint) {
    io.err(
      `Operation "${op.id}" is missing provider.authorization_endpoint/token_endpoint. Declare both in the manifest before running the broker (see docs/MANIFEST.md).`,
    );
    return 1;
  }

  const profileName = credentialProfileName(opts.profile, op.auth);
  const prefix = envPrefix(profileName);
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  if (!clientId) {
    io.err(`Set ${prefix}_CLIENT_ID in the environment before running the broker.`);
    return 1;
  }
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];

  let loopback: { path: string; port: number };
  try {
    loopback = loopbackTarget(provider.redirectUri);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));
  const timeoutMs = Math.max(1, Number(opts.timeoutSeconds) || 300) * 1000;

  const redirectUriHolder: { value?: string } = {};
  const result = await awaitRedirect(
    loopback.path,
    loopback.port,
    state,
    timeoutMs,
    (actualPort) => {
      const redirectUri = `http://127.0.0.1:${actualPort}${loopback.path}`;
      redirectUriHolder.value = redirectUri;
      const authorizeUrl = new URL(provider.authorizationEndpoint as string);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      if (op.auth.scopes.length > 0)
        authorizeUrl.searchParams.set("scope", op.auth.scopes.join(" "));
      authorizeUrl.searchParams.set("state", state);
      if (provider.pkce !== false) {
        authorizeUrl.searchParams.set("code_challenge", challenge);
        authorizeUrl.searchParams.set("code_challenge_method", "S256");
      }
      io.out(`Open this URL to authorize (listening on ${redirectUri}):`);
      io.out(`  ${authorizeUrl.toString()}`);
      if (opts.open === true) openBrowser(authorizeUrl.toString(), io);
    },
  );
  if ("error" in result) {
    io.err(`Authorization did not complete: ${result.error}.`);
    return 1;
  }
  if (!redirectUriHolder.value) {
    io.err("Internal error: redirect_uri was never established.");
    return 1;
  }

  const exchanged = await exchangeCode(
    provider.tokenEndpoint,
    {
      grant_type: "authorization_code",
      code: result.code,
      redirect_uri: redirectUriHolder.value,
      code_verifier: verifier,
    },
    clientId,
    clientSecret,
    provider.clientAuth,
  );
  if (exchanged.error) {
    io.err(
      `Token exchange failed: ${exchanged.error}${exchanged.error_description ? ` — ${exchanged.error_description}` : ""}.`,
    );
    return 1;
  }
  if (!exchanged.refresh_token) {
    io.err(
      "The token endpoint did not return a refresh_token. Ensure the authorization request includes offline access (a provider-specific scope, e.g. 'offline_access', is often required) and retry.",
    );
    return 1;
  }

  const storeDir = credentialsDir(credentialsDirOverride);
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const filePath = join(storeDir, `${profileName}.json`);
  writeFileSync(
    filePath,
    `${JSON.stringify({ refresh_token: exchanged.refresh_token, obtained_at: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort: writeFileSync's mode already applied it on every platform
    // that honors POSIX permissions; this is defense against an inherited umask.
  }

  io.out(`Stored a refresh token at ${filePath} (mode 0600).`);
  io.out(
    `The runtime will read it when ${prefix}_REFRESH_TOKEN is unset. Review "${op.id}" and approve it explicitly — the broker never approves an operation.`,
  );
  return 0;
}

/** Exported for tests, which pass `credentialsDirOverride` to avoid touching a real `~/.anvil`. */
export function runAuthStatus(
  dir: string,
  opts: AuthStatusCliOptions,
  io: CliIO,
  credentialsDirOverride?: string,
): number {
  let air: AirDocument;
  try {
    air = loadAir(dir);
  } catch (err) {
    return emitRefusal(io, opts.json, {
      reportType: "anvil.auth-status-error",
      code: "auth_status_bundle_invalid",
      message: err instanceof Error ? err.message : String(err),
    });
  }
  const seen = new Set<string>();
  const rows: Array<{
    profile: string;
    auth: string;
    resolver: string;
    materialPresent: boolean;
    storedRefreshToken: boolean;
  }> = [];
  for (const op of air.operations) {
    if (op.auth.type === "none") continue;
    const profileName = credentialProfileName(opts.profile, op.auth);
    if (seen.has(profileName)) continue;
    seen.add(profileName);
    const req = credentialRequirement(profileName, op.auth);
    const groupSatisfied = (names: string[]): boolean =>
      names.every((n) => Boolean(process.env[n]));
    const materialPresent =
      groupSatisfied(req.required) &&
      (!req.requiredOneOf ||
        req.requiredOneOf.length === 0 ||
        req.requiredOneOf.some(groupSatisfied));
    const storedRefreshToken =
      op.auth.type === "oauth2_authorization_code" &&
      existsSync(join(credentialsDir(credentialsDirOverride), `${profileName}.json`));
    rows.push({
      profile: profileName,
      auth: req.auth,
      resolver: req.resolver,
      materialPresent: materialPresent || storedRefreshToken,
      storedRefreshToken,
    });
  }

  if (opts.json === true) {
    io.out(
      JSON.stringify(
        {
          schemaVersion: 1,
          reportType: "anvil.auth-status",
          service: air.service.id,
          profile: opts.profile,
          rows,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (rows.length === 0) {
    io.out(`No authenticated operations in '${air.service.id}'.`);
    return 0;
  }
  io.out(`Credential profiles for '${air.service.id}' (deployment profile '${opts.profile}')`);
  for (const row of rows) {
    io.out(`● ${row.profile}   ${row.auth}`);
    io.out(
      `  resolver: ${row.resolver}   material present: ${row.materialPresent ? "yes" : "no"}` +
        (row.storedRefreshToken ? " (stored refresh token found)" : ""),
    );
  }
  return 0;
}
