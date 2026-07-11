/**
 * Orchestrate BYO MCP adoption: capture → snapshot → AIR → capability contracts
 * + surface signature + a mode-specific plan. The mode is explicit and decides
 * what is generated; `adopt` never regenerates the provider server.
 */
import type { AirDocument } from "@anvil/air";
import { capabilityContractsFor } from "../capability/contract.js";
import type { CapabilityContract, SurfaceSignature } from "../capability/model.js";
import { surfaceSignatureFor } from "../capability/signature.js";
import { airFromMcpSurface } from "./air.js";
import type { AdoptionMode, AdoptionPlan, McpProbe, McpSurfaceSnapshot } from "./model.js";
import {
  type BuildSnapshotOptions,
  buildMcpSurfaceSnapshot,
  type SnapshotDiagnostic,
} from "./snapshot.js";

export interface AdoptOptions extends BuildSnapshotOptions {
  mode: AdoptionMode;
  serviceId?: string;
}

export interface AdoptionResult {
  snapshot: McpSurfaceSnapshot;
  air: AirDocument;
  capabilities: CapabilityContract[];
  /** The surface signature over the adopted tools (approved-only). */
  signature: SurfaceSignature;
  plan: AdoptionPlan;
}

export type AdoptOutcome =
  | { ok: true; result: AdoptionResult }
  | { ok: false; diagnostics: SnapshotDiagnostic[]; captureError?: string };

/** Plan what each mode emits — never regenerating the provider server blindly. */
export function planAdoption(mode: AdoptionMode): AdoptionPlan {
  const base = ["cli", "skill", "simulator-binding", "certification-inputs", "system-pack"];
  switch (mode) {
    case "adopt":
      return {
        mode,
        regenerateServer: false,
        facade: false,
        emits: base,
        notes: ["References the provider MCP endpoint directly; no server is generated."],
      };
    case "facade":
      return {
        mode,
        regenerateServer: false,
        facade: true,
        emits: [...base, "facade-runtime"],
        notes: ["Anvil policy/runtime controls are placed in front of the provider server."],
      };
    case "replace":
      return {
        mode,
        regenerateServer: true,
        facade: false,
        emits: [...base, "mcp-server"],
        notes: [
          "Generates a fresh MCP server from the upstream API; requires the upstream",
          "API source in addition to the captured surface.",
        ],
      };
  }
}

/**
 * Adopt an MCP server. Captures its surface through the injected probe, validates
 * and freezes it, bridges it into AIR, and derives the capability contracts,
 * surface signature, and plan. A capture failure or invalid surface is returned
 * as a typed diagnostic — never thrown.
 */
export async function adoptMcp(
  endpoint: string,
  probe: McpProbe,
  options: AdoptOptions,
): Promise<AdoptOutcome> {
  const captured = await probe.capture(endpoint);
  if (!captured.ok) {
    return {
      ok: false,
      diagnostics: [
        { level: "error", code: "mcp/no_tools", message: `${captured.code}: ${captured.message}` },
      ],
      captureError: captured.code,
    };
  }

  const built = buildMcpSurfaceSnapshot(captured.capture, options);
  if (!built.ok) return { ok: false, diagnostics: built.diagnostics };

  const air = airFromMcpSurface(built.snapshot, { serviceId: options.serviceId });
  const capabilities = capabilityContractsFor(air);
  // The adopted signature reflects the provider's actual surface (all captured
  // tools), independent of Anvil's own approval gate on what it will re-expose.
  const signature = surfaceSignatureFor(air, undefined, { includeAllStates: true });
  return {
    ok: true,
    result: {
      snapshot: built.snapshot,
      air,
      capabilities,
      signature,
      plan: planAdoption(options.mode),
    },
  };
}
