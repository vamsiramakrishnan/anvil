import type { IncomingMessage, ServerResponse } from "node:http";
import type { FleetServer } from "@anvil/mcp-runtime";
import { type Principal, withInboundIdentity } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { json, readSmallJson } from "./fleet-http-io.js";

/** HTTP status for an Anvil error code on the REST call route. */
const REST_STATUS: Record<string, number> = {
  validation_error: 400,
  auth_required: 401,
  permission_denied: 403,
  policy_denied: 403,
  not_found: 404,
  conflict: 409,
  confirmation_required: 428,
  idempotency_required: 428,
  rate_limited: 429,
  unsupported_operation: 422,
  schema_mismatch: 502,
  upstream_unavailable: 502,
  unknown_upstream_error: 502,
  upstream_timeout: 504,
  unsafe_retry_blocked: 409,
  idempotency_ledger_unavailable: 503,
};

/** JSON safe to put in a header: non-ASCII escaped, so the value is printable ASCII. */
function headerJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** A CallToolResult turned back into the data a direct call returns (the SDKs' rule). */
function decodeCallResult(
  result: CallToolResult,
): { ok: true; data: unknown } | { ok: false; error: Record<string, unknown> } {
  const text = result.content?.find((item) => item.type === "text");
  const raw = text && "text" in text ? String(text.text) : "";
  if (result.isError) {
    try {
      const envelope = JSON.parse(raw) as { error?: Record<string, unknown> };
      if (envelope.error && typeof envelope.error.code === "string") {
        return { ok: false, error: envelope.error };
      }
    } catch {
      // not an Anvil envelope
    }
    // The MCP layer's own refusal (arguments that fail the tool's input
    // schema) is not an Anvil envelope; it is the caller's input to fix.
    const invalidInput = /^MCP error -32602\b/.test(raw);
    return {
      ok: false,
      error: {
        code: invalidInput ? "validation_error" : "unknown_upstream_error",
        message: raw.slice(0, 1000),
      },
    };
  }
  const structured = result.structuredContent;
  if (structured && typeof structured === "object") {
    if ("anvil_dry_run" in structured) return { ok: true, data: structured.anvil_dry_run };
    if ("anvil_unvalidated" in structured) return { ok: true, data: structured.anvil_unvalidated };
  }
  try {
    return { ok: true, data: JSON.parse(raw) as unknown };
  } catch {
    // fall through to the structured channel
  }
  if (structured && typeof structured === "object") {
    const keys = Object.keys(structured);
    return {
      ok: true,
      data: keys.length === 1 && keys[0] === "result" ? structured.result : structured,
    };
  }
  return { ok: true, data: raw };
}

/**
 * `POST /call/<tool>` — one tool call over plain HTTP (ADR-0030), for a caller
 * that does not speak MCP. The same principal, grant, gates, and executor as
 * `/mcp` (the call runs through a fleet composed for this caller, over an
 * in-process MCP pair), so nothing here is a second enforcement path.
 *
 * Body: `{"arguments": {...}, "stage": true?}`. `Idempotency-Key` header: the
 * key to send upstream (and the call's ledger id). Answer: the response data
 * (200), or `{"error": {...}}` with a status for its code; the effect report
 * rides in the `X-Anvil-Effect` header as JSON.
 */
export async function handleRestCall(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  caller: {
    principal: Principal | undefined;
    identity: Parameters<typeof withInboundIdentity>[0] | undefined;
    build: (principal: Principal | undefined) => Promise<FleetServer>;
  },
): Promise<void> {
  const fail = (status: number, code: string, message: string) =>
    json(res, status, { error: { code, message } });
  if (req.method !== "POST") {
    req.resume();
    return fail(405, "method_not_allowed", "Call a tool with POST.");
  }
  const mediaType = String(req.headers["content-type"] ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    req.resume();
    return fail(415, "unsupported_media_type", "Content-Type must be application/json.");
  }
  const tool = decodeURIComponent(url.pathname.slice("/call/".length));
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool)) return fail(404, "not_found", "No such tool.");
  const body = await readSmallJson(req);
  if (!body) return fail(400, "validation_error", "Expected a JSON object body.");
  const args = body.arguments ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return fail(400, "validation_error", "`arguments` must be a JSON object.");
  }
  if (body.stage !== undefined && typeof body.stage !== "boolean") {
    return fail(400, "validation_error", "`stage` must be a boolean.");
  }
  const keyHeader = req.headers["idempotency-key"];
  if (Array.isArray(keyHeader)) {
    return fail(400, "validation_error", "Send one Idempotency-Key header.");
  }
  const meta: Record<string, unknown> = {};
  if (typeof keyHeader === "string" && keyHeader.length > 0) meta.idempotency_key = keyHeader;
  if (body.stage === true) meta.stage = true;

  let fleet: FleetServer;
  try {
    fleet = await caller.build(caller.principal);
  } catch {
    return fail(500, "internal_error", "The call could not be prepared.");
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "anvil-rest", version: "0.0.0" });
  try {
    await fleet.server.connect(serverTransport);
    await client.connect(clientTransport);
    if (!fleet.toolOwners.has(tool)) return fail(404, "not_found", `No tool '${tool}'.`);
    const call = () =>
      client.callTool({
        name: tool,
        arguments: args as Record<string, unknown>,
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
      });
    const result = (await (caller.identity
      ? withInboundIdentity(caller.identity, call)
      : call())) as CallToolResult;
    const effect = result._meta?.effect;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(effect !== undefined ? { "x-anvil-effect": headerJson(effect) } : {}),
    };
    const decoded = decodeCallResult(result);
    const status = decoded.ok ? 200 : (REST_STATUS[String(decoded.error.code)] ?? 502);
    res.writeHead(status, headers);
    res.end(JSON.stringify(decoded.ok ? decoded.data : { error: decoded.error }));
  } catch (error) {
    if (!res.headersSent) {
      fail(400, "validation_error", (error as Error).message.slice(0, 300));
    }
  } finally {
    await client.close().catch(() => undefined);
    await fleet.server.close().catch(() => undefined);
    await fleet.close().catch(() => undefined);
  }
}
