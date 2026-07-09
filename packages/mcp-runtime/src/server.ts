import type { AirDocument, Operation } from "@anvil/air";
import { type ExecuteContext, execute } from "@anvil/runtime";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { operationZodShape } from "./zodshape.js";

/**
 * A resource the MCP server advertises to agents (skill, catalog, CLI install
 * manifest). It is **precomputed data**, not built here — the build-time
 * generators produce it and the deployed runtime just serves it. That keeps the
 * serving path free of any dependency on the artifact foundry.
 */
export interface ServedResource {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  text: string;
  /** MCP annotation: who this is for and how important. */
  audience: Array<"user" | "assistant">;
  priority: number;
}

export interface McpBuildOptions {
  /**
   * Produces the execution context for an operation call. In production this
   * wires FetchTransport + credential resolver + ledger + observer; in tests it
   * injects a MockTransport. This is the only seam between MCP and upstream.
   */
  contextFor: (op: Operation) => ExecuteContext;
  /** Expose non-approved operations too (dev only). Default false (spec §17). */
  includeUnapproved?: boolean;
  /**
   * Precomputed resources to advertise (skill + CLI install manifest + catalog),
   * so agents can discover and materialize them adjacent to themselves. The
   * generators build these at compile time; pass an empty list (or omit) to
   * serve tools only.
   */
  resources?: ServedResource[];
}

function toolDescription(op: Operation): string {
  const parts = [op.description || op.displayName];
  if (op.effect.kind === "mutation") {
    parts.push(
      `This is a ${op.effect.reversible ? "" : "irreversible "}${op.effect.risk} mutation.`,
    );
    if (op.idempotency.mode === "required") parts.push("Requires an idempotency key.");
    if (op.confirmation.required) parts.push("Requires confirm=true.");
    parts.push(op.retries.mode === "safe" ? "Retry-safe." : "Not retry-safe.");
  } else {
    parts.push("Read-only.");
  }
  return parts.join(" ");
}

/**
 * Build a compliant MCP server exposing approved AIR operations as tools. Tool
 * metadata makes risk visible to the model (spec §8): standard hints plus Anvil
 * effect/idempotency semantics in `_meta`. Resource serving is data-driven —
 * pass `options.resources`; this runtime never generates them.
 */
export function buildMcpServer(air: AirDocument, options: McpBuildOptions): McpServer {
  const server = new McpServer({
    name: `${air.service.id}-tools`,
    version: air.service.version,
  });

  const ops = air.operations.filter((op) => options.includeUnapproved || op.state === "approved");

  for (const op of ops) {
    server.registerTool(
      op.mcp.toolName,
      {
        title: op.displayName,
        description: toolDescription(op),
        inputSchema: operationZodShape(op),
        annotations: {
          title: op.displayName,
          readOnlyHint: op.effect.kind === "read",
          destructiveHint: op.effect.kind === "mutation" && !op.effect.reversible,
          idempotentHint: op.idempotency.mode !== "none",
          openWorldHint: true,
        },
        _meta: {
          "anvil/effect": op.effect.kind,
          "anvil/risk": op.effect.risk,
          "anvil/retry_safe": op.retries.mode === "safe",
          "anvil/idempotency": op.idempotency.mode,
          "anvil/operation_id": op.id,
        },
      },
      async (args: Record<string, unknown>) => {
        const result = await execute(op, { input: args }, options.contextFor(op));
        if (result.outcome === "success") {
          const data = result.data ?? null;
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
            structuredContent: isRecord(data) ? data : { result: data },
          };
        }
        if (result.outcome === "dry_run") {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result.plan, null, 2) }],
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.envelope, null, 2) }],
          isError: true,
        };
      },
    );
  }

  // Advertise precomputed resources (skill + CLI install manifest + catalog) so
  // the deployed server is self-describing: an agent connects, reads SKILL.md
  // first, then materializes the CLI adjacent to itself.
  for (const resource of options.resources ?? []) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType,
        annotations: { audience: resource.audience, priority: resource.priority },
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: resource.mimeType, text: resource.text }],
      }),
    );
  }

  return server;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
