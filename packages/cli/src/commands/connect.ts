import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil connect <workspace> <connector> [--account <name>]` — connect one of
 * the person's upstream accounts to a running Branchyard gateway
 * (docs/branchyard.md). The gateway owns the flow; this command asks it for
 * an authorization URL and prints it (or opens it with `--open`), or, for a
 * key-based connector, submits the key read from stdin. The person's connect
 * token (`by_purpose: "connect"`, which `by connect` mints; the gateway
 * refuses a harness's turn token here) comes from `--token-file` /
 * `ANVIL_GATEWAY_TOKEN_FILE`, and the gateway from `--gateway` /
 * `ANVIL_GATEWAY_URL`. `<workspace>` is the directory the gateway serves; it is read only
 * to check the connector exists before anything is sent.
 */
export function registerConnect(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("connect")
      .summary("Connect a person's upstream account to a running Branchyard gateway.")
      .description(
        'Asks the gateway (ANVIL_GATEWAY_URL or --gateway) for an OAuth authorization URL for the connector and prints it, or opens it with --open. A key-based connector reads its key from stdin with --api-key-stdin. The person is identified by their connect token (ANVIL_GATEWAY_TOKEN_FILE or --token-file; by_purpose "connect" — the gateway refuses a turn token here); tokens never leave the gateway.',
      )
      .argument("<workspace>", "the workspace directory the gateway serves")
      .argument(
        "<connector>",
        "the connector id (the bundle's directory, folded like a fleet prefix)",
      )
      .option("--account <name>", "which of the person's accounts to connect (default: default)")
      .option("--gateway <url>", "the gateway's /mcp URL (default: ANVIL_GATEWAY_URL)")
      .option(
        "--token-file <path>",
        'the person\'s connect token file (by_purpose "connect", as `by connect` mints it; default: ANVIL_GATEWAY_TOKEN_FILE)',
      )
      .option(
        "--api-key-stdin",
        "read an API key or personal token for a key-based connector from stdin",
      )
      .option("--open", "open the authorization URL in the default browser as well as printing it")
      .action(async (workspace: string, connector: string, opts: ConnectOptions) => {
        ctx.code = await runConnect(
          workspace,
          connector,
          opts,
          ctx.io,
          ctx.deps.env ?? process.env,
        );
      }),
    { mutates: true },
  );
}

interface ConnectOptions {
  account?: string;
  gateway?: string;
  tokenFile?: string;
  apiKeyStdin?: boolean;
  open?: boolean;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function runConnect(
  workspace: string,
  connector: string,
  opts: ConnectOptions,
  io: CliIO,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const { discoverBundles } = await import("@anvil/generators");
  const { fleetToolPrefix } = await import("@anvil/mcp-runtime");
  const served = discoverBundles(workspace).map((bundle) => fleetToolPrefix(bundle.id));
  if (!served.includes(connector)) {
    io.err(
      `anvil: no connector '${connector}' in ${workspace}` +
        (served.length > 0 ? ` (it serves: ${served.join(", ")}).` : " (no bundles found)."),
    );
    return 1;
  }
  const gatewayRaw = opts.gateway ?? env.ANVIL_GATEWAY_URL;
  let gateway: URL;
  try {
    gateway = new URL(gatewayRaw ?? "");
    if ((gateway.protocol !== "https:" && gateway.protocol !== "http:") || gateway.username) {
      throw new Error("bad gateway URL");
    }
  } catch {
    io.err("anvil: name the gateway's /mcp URL with --gateway or ANVIL_GATEWAY_URL.");
    return 1;
  }
  const tokenFile = opts.tokenFile ?? env.ANVIL_GATEWAY_TOKEN_FILE;
  let token = "";
  try {
    token = tokenFile ? readFileSync(tokenFile, "utf8").trim() : "";
  } catch {
    token = "";
  }
  if (!token) {
    io.err(
      "anvil: the person's gateway token is needed (--token-file or ANVIL_GATEWAY_TOKEN_FILE naming a readable, non-empty file).",
    );
    return 4;
  }
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const account = opts.account ? { account: opts.account } : {};
  const post = async (path: string, body: unknown) => {
    const res = await fetch(new URL(path, gateway), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  };
  let started: { status: number; json: Record<string, unknown> };
  try {
    started = await post("/connect/start", { connector, ...account });
  } catch {
    io.err(`anvil: the gateway at ${gateway.origin} could not be reached.`);
    return 7;
  }
  if (started.status !== 200) return refusal(io, started);
  if (started.json.kind === "oauth" && typeof started.json.url === "string") {
    const url = started.json.url;
    io.out(url);
    io.err(
      `anvil: open the URL above to connect ${connector}${opts.account ? ` (account ${opts.account})` : ""}; it expires at ${String(started.json.expires_at)}.`,
    );
    if (opts.open) openInBrowser(url);
    return 0;
  }
  if (started.json.kind === "static") {
    if (!opts.apiKeyStdin) {
      io.err(
        `anvil: connector '${connector}' is connected with an API key or personal token; pipe it in: anvil connect ${workspace} ${connector} --api-key-stdin < key-file`,
      );
      return 1;
    }
    const secret = (await readStdin()).trim();
    if (!secret) {
      io.err("anvil: no key arrived on stdin.");
      return 1;
    }
    const stored = await post("/connect/api-key", { connector, ...account, api_key: secret });
    if (stored.status !== 200) return refusal(io, stored);
    io.out(`Connected ${connector} (account ${String(stored.json.account)}).`);
    return 0;
  }
  io.err("anvil: the gateway's answer was not understood.");
  return 1;
}

function refusal(io: CliIO, answer: { status: number; json: Record<string, unknown> }): number {
  const error = (answer.json.error ?? {}) as { code?: unknown; message?: unknown };
  io.err(
    `anvil: the gateway refused (${answer.status} ${String(error.code ?? "error")}): ${String(error.message ?? "")}`,
  );
  return answer.status === 401 || answer.status === 403 ? 4 : 1;
}

function openInBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    const child = spawn(command, [url], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Printing the URL already happened; opening it is a convenience.
  }
}
