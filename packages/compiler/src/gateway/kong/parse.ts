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
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return {
      ok: false,
      diagnostics: [
        {
          level: "error",
          code: "kong/invalid_export",
          message: "The Kong gateway export must be a mapping/object.",
          coordinate: { origin },
        },
      ],
    };
  }
  const services = (doc as Record<string, unknown>).services;
  if (!Array.isArray(services)) {
    return {
      ok: false,
      diagnostics: [
        {
          level: "error",
          code: "kong/invalid_export",
          message:
            "The Kong export must contain a `services` array; this is not a Kong declarative export.",
          coordinate: { origin },
        },
      ],
    };
  }
  if (services.length === 0) {
    return {
      ok: false,
      diagnostics: [
        {
          level: "error",
          code: "kong/empty_export",
          message: "The Kong export contains no services.",
          coordinate: { origin, pointer: "/services" },
        },
      ],
    };
  }
  if (
    services.some(
      (service) =>
        service === null ||
        typeof service !== "object" ||
        typeof (service as Record<string, unknown>).name !== "string" ||
        ((service as Record<string, unknown>).name as string).length === 0,
    )
  ) {
    return {
      ok: false,
      diagnostics: [
        {
          level: "error",
          code: "kong/invalid_export",
          message: "Every Kong service must be an object with a non-empty `name`.",
          coordinate: { origin, pointer: "/services" },
        },
      ],
    };
  }
  return { ok: true, config: doc as KongDeclarativeConfig };
}
