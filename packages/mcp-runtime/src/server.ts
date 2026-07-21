import { type AirDocument, mcpToolAnnotations, mcpToolDescription, type Operation } from "@anvil/air";
import { type ExecuteContext, execute } from "@anvil/runtime";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_RESERVED, operationZodShape, reservedSafetyShape } from "./zodshape.js";

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
        description: mcpToolDescription(op),
        // Operation input + the reserved safety controls (anvil_dry_run /
        // anvil_confirm / anvil_idempotency_key), so a client — the CLI over its
        // MCP transport, or any direct MCP caller — can dry-run and confirm.
        inputSchema: { ...operationZodShape(op), ...reservedSafetyShape(op) },
        // Shared with the Agent Registry toolspec (@anvil/air) — no drift.
        annotations: mcpToolAnnotations(op),
        _meta: {
          "anvil/effect": op.effect.kind,
          "anvil/action": op.effect.action,
          "anvil/risk": op.effect.risk,
          "anvil/retry_safe": op.retries.mode === "safe",
          "anvil/retry_basis": op.retries.basis,
          "anvil/idempotency": op.idempotency.mode,
          "anvil/principal": op.auth.principal,
          "anvil/operation_id": op.id,
        },
      },
      async (args: Record<string, unknown>) => {
        // Peel the reserved dry-run control off the arguments; the rest is the
        // operation input. `confirm` and `idempotency_key` are ordinary input
        // fields (synthesized by operationInputSchema) that the executor reads
        // straight out of `input`, so they need no special handling here — the
        // same safety contract holds whether an op is invoked directly, over the
        // CLI, or over the CLI routed through this server (local stdio / remote SSE).
        const dryRun = args[MCP_RESERVED.dryRun] === true;
        const input = { ...args };
        delete input[MCP_RESERVED.dryRun];
        const result = await execute(op, { input, dryRun }, options.contextFor(op));
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
