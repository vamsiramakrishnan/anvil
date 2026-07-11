/**
 * Build and validate an `McpSurfaceSnapshot` from a capture, and diff two
 * snapshots for server drift. Validation is a gate that returns findings as data:
 * a malformed tool schema, duplicate tool names, or a tool count over policy are
 * refusals, not silent acceptance.
 */
import { hashCanonical } from "@anvil/air";
import type { McpCapture, McpSurfaceSnapshot, McpTool } from "./model.js";

export interface SnapshotDiagnostic {
  level: "error" | "warning";
  code:
    | "mcp/malformed_tool_schema"
    | "mcp/duplicate_tool"
    | "mcp/tool_budget_exceeded"
    | "mcp/no_tools";
  message: string;
}

export interface BuildSnapshotOptions {
  /** Reject a surface advertising more than this many tools (agent selection budget). */
  maxTools?: number;
}

export type BuildSnapshotResult =
  | { ok: true; snapshot: McpSurfaceSnapshot }
  | { ok: false; diagnostics: SnapshotDiagnostic[] };

function isPlainObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate a capture and freeze it into a content-addressed snapshot. */
export function buildMcpSurfaceSnapshot(
  capture: McpCapture,
  options: BuildSnapshotOptions = {},
): BuildSnapshotResult {
  const diagnostics: SnapshotDiagnostic[] = [];

  if (capture.tools.length === 0) {
    diagnostics.push({
      level: "error",
      code: "mcp/no_tools",
      message: "Server advertises no tools.",
    });
  }

  const seen = new Set<string>();
  for (const tool of capture.tools) {
    if (!isPlainObject(tool.inputSchema)) {
      diagnostics.push({
        level: "error",
        code: "mcp/malformed_tool_schema",
        message: `Tool '${tool.name}' has a non-object inputSchema.`,
      });
    }
    if (seen.has(tool.name)) {
      diagnostics.push({
        level: "error",
        code: "mcp/duplicate_tool",
        message: `Duplicate tool name '${tool.name}'.`,
      });
    }
    seen.add(tool.name);
  }

  if (options.maxTools !== undefined && capture.tools.length > options.maxTools) {
    diagnostics.push({
      level: "error",
      code: "mcp/tool_budget_exceeded",
      message: `Server advertises ${capture.tools.length} tools; policy allows ${options.maxTools}.`,
    });
  }

  if (diagnostics.some((d) => d.level === "error")) return { ok: false, diagnostics };

  const tools = [...capture.tools].sort((a, b) => a.name.localeCompare(b.name));
  const resources = [...(capture.resources ?? [])].sort((a, b) => a.uri.localeCompare(b.uri));
  const prompts = [...(capture.prompts ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const digest = hashCanonical({
    protocolVersion: capture.protocolVersion,
    server: capture.server,
    transport: capture.transport,
    serverCapabilities: capture.serverCapabilities ?? {},
    tools,
    resources,
    prompts,
  });

  return {
    ok: true,
    snapshot: {
      schemaVersion: 1,
      endpoint: capture.endpoint,
      protocolVersion: capture.protocolVersion,
      server: capture.server,
      transport: capture.transport,
      serverCapabilities: capture.serverCapabilities ?? {},
      tools,
      resources,
      prompts,
      digest,
    },
  };
}

export interface McpDrift {
  addedTools: string[];
  removedTools: string[];
  changedTools: string[];
  protocolChanged: boolean;
}

/** Detect drift between a previously captured surface and a new one. */
export function diffMcpSurface(prev: McpSurfaceSnapshot, next: McpSurfaceSnapshot): McpDrift {
  const prevTools = new Map(prev.tools.map((t) => [t.name, t]));
  const nextTools = new Map(next.tools.map((t) => [t.name, t]));
  const changed = (a: McpTool, b: McpTool) => hashCanonical(a) !== hashCanonical(b);
  return {
    addedTools: [...nextTools.keys()].filter((n) => !prevTools.has(n)).sort(),
    removedTools: [...prevTools.keys()].filter((n) => !nextTools.has(n)).sort(),
    changedTools: [...nextTools.keys()]
      .filter((n) => prevTools.has(n) && changed(prevTools.get(n)!, nextTools.get(n)!))
      .sort(),
    protocolChanged: prev.protocolVersion !== next.protocolVersion,
  };
}
