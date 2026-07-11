/**
 * BYO MCP adoption models. An existing MCP server is a first-class *source*: its
 * live surface is captured into an immutable `McpSurfaceSnapshot`, then bridged
 * into AIR so it flows through the one capability/signature/pack pipeline — the
 * same path an OpenAPI file takes.
 *
 * Three explicit modes decide what Anvil generates, never guessed:
 *   - adopt   — reference the provider endpoint as-is (no new server).
 *   - facade  — put Anvil's policy/runtime controls in front of the provider.
 *   - replace — generate a fresh MCP from the upstream API (needs that API).
 *
 * Capture is the impure edge (it talks to a server) and is injected via
 * `McpProbe`; everything else — validation, the AIR bridge, planning, drift — is
 * pure and content-addressed.
 */
import type { JsonSchema } from "@anvil/air";
import { z } from "zod";

/** The transport an MCP server is reached over. */
export const McpTransport = z.enum(["stdio", "streamable-http", "sse", "unknown"]);
export type McpTransport = z.infer<typeof McpTransport>;

/** MCP tool annotation hints (spec) that inform conservative safety inference. */
export const McpToolAnnotations = z.object({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});
export type McpToolAnnotations = z.infer<typeof McpToolAnnotations>;

export const McpTool = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.custom<JsonSchema>((v) => typeof v === "object" && v !== null),
  annotations: McpToolAnnotations.optional(),
});
export type McpTool = z.infer<typeof McpTool>;

export const McpResource = z.object({
  uri: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});
export type McpResource = z.infer<typeof McpResource>;

export const McpPrompt = z.object({
  name: z.string(),
  description: z.string().optional(),
});
export type McpPrompt = z.infer<typeof McpPrompt>;

/** The immutable, content-addressed capture of an MCP server's public surface. */
export const McpSurfaceSnapshot = z.object({
  schemaVersion: z.literal(1),
  endpoint: z.string(),
  protocolVersion: z.string(),
  server: z.object({ name: z.string(), version: z.string() }),
  transport: McpTransport,
  /** The server's advertised capabilities (tools/resources/prompts/…), verbatim. */
  serverCapabilities: z.record(z.string(), z.unknown()).default({}),
  tools: z.array(McpTool).default([]),
  resources: z.array(McpResource).default([]),
  prompts: z.array(McpPrompt).default([]),
  /** Content digest over the surface (excludes the endpoint address). */
  digest: z.string(),
});
export type McpSurfaceSnapshot = z.infer<typeof McpSurfaceSnapshot>;

/** The raw data a probe captures, before validation and digesting. */
export interface McpCapture {
  endpoint: string;
  protocolVersion: string;
  server: { name: string; version: string };
  transport: McpTransport;
  serverCapabilities?: Record<string, unknown>;
  tools: McpTool[];
  resources?: McpResource[];
  prompts?: McpPrompt[];
}

/** A structured capture outcome — an unreachable endpoint is data, not a throw. */
export type McpCaptureResult =
  | { ok: true; capture: McpCapture }
  | { ok: false; code: "unreachable" | "handshake_failed" | "protocol_error"; message: string };

/** The impure edge: connect to an MCP server and capture its surface. */
export interface McpProbe {
  capture(endpoint: string): Promise<McpCaptureResult>;
}

export const AdoptionMode = z.enum(["adopt", "facade", "replace"]);
export type AdoptionMode = z.infer<typeof AdoptionMode>;

/** What an adoption will generate — modes never regenerate blindly. */
export interface AdoptionPlan {
  mode: AdoptionMode;
  /** True only for `replace`: a fresh MCP server is generated from the upstream API. */
  regenerateServer: boolean;
  /** True for `facade`: Anvil control-plane sits in front of the provider. */
  facade: boolean;
  /** The surfaces Anvil will emit alongside (CLI, skill, simulator binding, …). */
  emits: string[];
  notes: string[];
}
