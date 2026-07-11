/**
 * Normalize Kong plugins into evidence-backed overlay facts and diagnostics.
 * Recognized plugins (auth, rate-limiting, transformers, termination, cache) are
 * mapped to their semantic meaning; anything unrecognized stays **visible as an
 * opaque policy** rather than being silently dropped — the honesty invariant.
 */
import type { EvidenceCoordinate, GatewayDiagnostic } from "../model.js";
import type { GatewayFact } from "../overlay.js";
import type { KongPlugin, KongService } from "./model.js";

const AUTH_PLUGINS: Record<string, string> = {
  "key-auth": "API key",
  "key-auth-enc": "API key",
  jwt: "JWT",
  "openid-connect": "OAuth2 (OIDC)",
  "basic-auth": "Basic auth",
  "hmac-auth": "HMAC",
};
const RATE_LIMIT_PLUGINS = new Set([
  "rate-limiting",
  "rate-limiting-advanced",
  "response-ratelimiting",
]);
const TRANSFORM_PLUGINS = new Set([
  "request-transformer",
  "request-transformer-advanced",
  "response-transformer",
  "response-transformer-advanced",
]);
const KNOWN_OTHER = new Set([
  "cors",
  "proxy-cache",
  "acl",
  "ip-restriction",
  "request-termination",
  "bot-detection",
]);

export interface PluginNormalization {
  facts: GatewayFact[];
  diagnostics: GatewayDiagnostic[];
  authSummary?: string;
  hasQuota: boolean;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/** Normalize one service's plugins, applied to every operation of the service. */
export function normalizeServicePlugins(
  service: KongService,
  svcIndex: number,
  operationIds: readonly string[],
  origin: string,
): PluginNormalization {
  const facts: GatewayFact[] = [];
  const diagnostics: GatewayDiagnostic[] = [];
  let authSummary: string | undefined;
  let hasQuota = false;

  const plugins = service.plugins ?? [];
  plugins.forEach((plugin, pluginIndex) => {
    if (plugin.enabled === false) return;
    const coordinate: EvidenceCoordinate = {
      origin,
      pointer: `/services/${svcIndex}/plugins/${pluginIndex}`,
    };

    if (AUTH_PLUGINS[plugin.name]) {
      authSummary = AUTH_PLUGINS[plugin.name];
      const scopes = asStringArray(plugin.config?.scopes);
      if (scopes.length > 0) {
        for (const ref of operationIds) {
          facts.push({
            target: { scope: "operation", ref },
            predicate: "auth.scopes",
            operation: "restrict",
            value: scopes,
            coordinate,
            note: `${plugin.name} required scopes`,
          });
        }
      }
      return;
    }

    if (RATE_LIMIT_PLUGINS.has(plugin.name)) {
      hasQuota = true;
      diagnostics.push({
        level: "info",
        code: "kong/quota_present",
        message: `Rate limiting (${plugin.name}) on service '${service.name}' — a quota applies but is not an operation semantic.`,
        coordinate,
      });
      return;
    }

    if (TRANSFORM_PLUGINS.has(plugin.name)) {
      diagnostics.push({
        level: "warning",
        code: "gateway/opaque_policy",
        message: `Transformation plugin '${plugin.name}' on '${service.name}' is not modelled; it changes requests/responses and blocks automatic certification.`,
        coordinate,
      });
      return;
    }

    if (KNOWN_OTHER.has(plugin.name)) {
      diagnostics.push({
        level: "info",
        code: "kong/policy_noted",
        message: `Plugin '${plugin.name}' on '${service.name}' noted.`,
        coordinate,
      });
      return;
    }

    // Unknown plugin — stays visible as an opaque policy.
    diagnostics.push({
      level: "warning",
      code: "gateway/opaque_policy",
      message: `Unknown Kong plugin '${plugin.name}' on '${service.name}' is opaque and preserved as evidence, not interpreted.`,
      coordinate,
    });
  });

  return { facts, diagnostics, authSummary, hasQuota };
}
