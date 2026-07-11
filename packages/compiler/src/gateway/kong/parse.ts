/**
 * Parse a Kong declarative config (YAML or JSON). Returns the config as data or a
 * typed diagnostic — a malformed export is never a throw.
 */
import { parse as parseYaml } from "yaml";
import type { GatewayDiagnostic } from "../model.js";
import type { KongDeclarativeConfig } from "./model.js";

export type ParseKongResult =
  | { ok: true; config: KongDeclarativeConfig }
  | { ok: false; diagnostics: GatewayDiagnostic[] };

export function parseKongConfig(text: string, origin = "kong.yaml"): ParseKongResult {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    return {
      ok: false,
      diagnostics: [
        {
          level: "error",
          code: "kong/unparseable",
          message: `Could not parse Kong config: ${String(err)}`,
          coordinate: { origin },
        },
      ],
    };
  }
  if (!doc || typeof doc !== "object") {
    return {
      ok: false,
      diagnostics: [
        {
          level: "error",
          code: "kong/invalid",
          message: "Kong config is not an object.",
          coordinate: { origin },
        },
      ],
    };
  }
  return { ok: true, config: doc as KongDeclarativeConfig };
}
