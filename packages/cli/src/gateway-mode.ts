import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Operation } from "@anvil/air";
import { AnvilError } from "@anvil/runtime";

/**
 * Gateway mode for the generated CLI (ADR-0029, docs/branchyard.md): with
 * `ANVIL_GATEWAY_URL` set, every call goes to the Branchyard gateway through
 * the CLI's `--mcp <url>` path (ADR-0023). This module decides the call — the
 * target, the bearer, the wire tool name — or the structured refusal;
 * `runToolCli` then routes it like any remote MCP call.
 *
 * The token file is read here, per call, so a token replaced each turn is
 * picked up; its contents never reach argv, a URL, or an error. No upstream
 * credential variable is read.
 */

/** Flags that choose where or how a direct/MCP call runs — meaningless in gateway mode. */
const GATEWAY_EXCLUSIVE_FLAGS = [
  "mcp",
  "mcp-token-env",
  "base-url",
  "auth-profile",
  "protocol-facade",
  "timeout",
  "no-retries",
] as const;

/** The connector id a gateway mounts this service under (its fleet prefix). */
function defaultGatewayConnector(serviceId: string): string {
  return serviceId.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "bundle";
}

export type GatewayCall =
  | {
      ok: true;
      target: string;
      /** The CLI's safety flags, carried as the tool's reserved inputs. */
      safety: { confirm: boolean; dryRun: boolean; idempotencyKey?: string };
      /** The bearer, read from the token file for this call only. */
      auth: { bearerToken: string };
      toolName: string;
    }
  | { ok: false; error: AnvilError };

function refusal(
  code: "validation_error" | "auth_required",
  op: Operation,
  message: string,
  details?: unknown,
): GatewayCall {
  return {
    ok: false,
    error: new AnvilError({
      code,
      message,
      operation: op.id,
      traceId: `trace_${randomUUID()}`,
      details,
    }),
  };
}

/** The gateway call for this invocation, its refusal, or undefined when gateway mode is off. */
export function resolveGatewayCall(
  op: Operation,
  serviceId: string,
  flags: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv,
  connectorOverride?: string,
): GatewayCall | undefined {
  const gatewayUrl = env.ANVIL_GATEWAY_URL?.trim();
  if (!gatewayUrl) return undefined;
  const exclusive = GATEWAY_EXCLUSIVE_FLAGS.filter((flag) => flags[flag] !== undefined).map(
    (flag) => `--${flag}`,
  );
  if (exclusive.length > 0) {
    return refusal(
      "validation_error",
      op,
      `Gateway mode (ANVIL_GATEWAY_URL is set) sends every call to the gateway; ${exclusive.join(", ")} cannot apply.`,
      { gateway_mode: true, flags: exclusive },
    );
  }
  let url: URL;
  try {
    url = new URL(gatewayUrl);
  } catch {
    return refusal("validation_error", op, "ANVIL_GATEWAY_URL must be the gateway's /mcp URL.", {
      env: "ANVIL_GATEWAY_URL",
    });
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    return refusal(
      "validation_error",
      op,
      "ANVIL_GATEWAY_URL must be the gateway's HTTP(S) /mcp URL, without credentials.",
      { env: "ANVIL_GATEWAY_URL" },
    );
  }
  const tokenFile = env.ANVIL_GATEWAY_TOKEN_FILE?.trim();
  let bearerToken = "";
  try {
    bearerToken = tokenFile ? readFileSync(tokenFile, "utf8").trim() : "";
  } catch {
    bearerToken = "";
  }
  if (!bearerToken) {
    return refusal(
      "auth_required",
      op,
      tokenFile
        ? "The gateway token file named by ANVIL_GATEWAY_TOKEN_FILE is missing, unreadable, or empty."
        : "Gateway mode needs ANVIL_GATEWAY_TOKEN_FILE to name this turn's token file.",
    );
  }
  const connector =
    env.ANVIL_GATEWAY_CONNECTOR?.trim() || connectorOverride || defaultGatewayConnector(serviceId);
  const idempotencyKey = flags["idempotency-key"];
  return {
    ok: true,
    target: url.toString(),
    safety: {
      confirm: flags.confirm === true,
      dryRun: flags["dry-run"] === true,
      ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}),
    },
    auth: { bearerToken },
    toolName: `${connector}__${op.mcp.toolName}`,
  };
}
