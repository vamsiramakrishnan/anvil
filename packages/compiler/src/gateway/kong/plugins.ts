/**
 * Normalize Kong plugins into evidence-backed overlay facts and diagnostics.
 * Recognized plugins (auth, rate-limiting, transformers, termination, cache) are
 * mapped to their semantic meaning; anything unrecognized stays **visible as an
 * opaque policy** rather than being silently dropped — the honesty invariant.
 */

import {
  projectConfiguredAuthType,
  projectExplicitIdentityConfiguration,
} from "../identity-evidence.js";
import type { EvidenceCoordinate, GatewayDiagnostic, GatewayIdentityEvidence } from "../model.js";
import { withGatewayDiagnosticSubject } from "../model.js";
import type { GatewayFact } from "../overlay.js";
import { asObjects, asRecord, asStrings } from "../parse-safe.js";
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
const INFORMATIONAL_PLUGINS = new Set(["cors"]);
const AUTH_TYPES = {
  "key-auth": "api_key",
  "key-auth-enc": "api_key",
  jwt: "jwt_bearer",
  "basic-auth": "basic",
} as const;

export interface PluginNormalization {
  facts: GatewayFact[];
  diagnostics: GatewayDiagnostic[];
  identityEvidence: GatewayIdentityEvidence[];
  authSummary?: string;
  hasQuota: boolean;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * Kong key-auth can accept a key in several places. Claim one exact carrier
 * only when the export explicitly disables every other supported location and
 * names exactly one key. Defaults are deliberately not treated as evidence.
 */
function exactKeyAuthCarrier(
  configValue: unknown,
): { in: "header" | "query"; name: string } | undefined {
  const config = asRecord(configValue);
  const names = asStrings(config.key_names);
  if (names.length !== 1) return undefined;
  if (
    typeof config.key_in_header !== "boolean" ||
    typeof config.key_in_query !== "boolean" ||
    typeof config.key_in_body !== "boolean"
  ) {
    return undefined;
  }
  if (config.key_in_body) return undefined;
  if (config.key_in_header === config.key_in_query) return undefined;
  return {
    in: config.key_in_header ? "header" : "query",
    name: names[0] as string,
  };
}

/** Normalize one service's plugins, applied to every operation of the service. */
export function normalizeServicePlugins(
  service: KongService,
  svcIndex: number,
  operationIds: readonly string[],
  origin: string,
  identityOperationRefs: readonly string[] = operationIds,
): PluginNormalization {
  const facts: GatewayFact[] = [];
  const diagnostics: GatewayDiagnostic[] = [];
  const identityEvidence: GatewayIdentityEvidence[] = [];
  let authSummary: string | undefined;
  let hasQuota = false;

  const plugins = asObjects<KongPlugin>(service.plugins);
  plugins.forEach((plugin, pluginIndex) => {
    if (plugin.enabled === false) return;
    const coordinate: EvidenceCoordinate = {
      origin,
      pointer: `/services/${svcIndex}/plugins/${pluginIndex}`,
    };

    if (AUTH_PLUGINS[plugin.name]) {
      authSummary = AUTH_PLUGINS[plugin.name];
      const authType = AUTH_TYPES[plugin.name as keyof typeof AUTH_TYPES];
      if (authType) {
        identityEvidence.push(
          ...projectConfiguredAuthType({
            type: authType,
            coordinate: { origin, pointer: `${coordinate.pointer}/name` },
            operationRefs: identityOperationRefs,
          }),
        );
      }
      // Only the OIDC plugin assigns these keys identity semantics. A stray
      // issuer/audience-shaped key on key-auth, JWT, or a basic-auth config is
      // not effective gateway policy and therefore is not evidence.
      if (plugin.name === "openid-connect") {
        const exact = projectExplicitIdentityConfiguration({
          configuration: plugin.config,
          coordinate: { origin, pointer: `${coordinate.pointer}/config` },
          operationRefs: identityOperationRefs,
          fields: ["issuer", "audience", "principal", "scopes"],
        });
        identityEvidence.push(...exact.evidence);
        diagnostics.push(...exact.diagnostics);
      }

      if (plugin.name === "key-auth" || plugin.name === "key-auth-enc") {
        const carrier = exactKeyAuthCarrier(plugin.config);
        if (carrier) {
          const projectedCarrier = projectExplicitIdentityConfiguration({
            configuration: { carrier },
            coordinate: { origin, pointer: `${coordinate.pointer}/config` },
            operationRefs: identityOperationRefs,
            fields: ["carrier"],
            fieldCoordinates: {
              carrier: { origin, pointer: `${coordinate.pointer}/config` },
            },
          });
          identityEvidence.push(...projectedCarrier.evidence);
          diagnostics.push(...projectedCarrier.diagnostics);
        }
      }
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

    if (INFORMATIONAL_PLUGINS.has(plugin.name)) {
      diagnostics.push({
        level: "info",
        code: "kong/policy_noted",
        message: `Plugin '${plugin.name}' on '${service.name}' noted.`,
        coordinate,
      });
      return;
    }

    // Authorization, termination, cache, bot/IP controls, and unknown plugins
    // change effective request behavior. Until their semantics and placement are
    // represented in AIR they must block a full-contract import rather than
    // disappearing behind an informational note.
    diagnostics.push({
      level: "warning",
      code: "gateway/opaque_policy",
      message: `Unknown Kong plugin '${plugin.name}' on '${service.name}' is opaque and preserved as evidence, not interpreted.`,
      coordinate,
    });
  });

  return {
    facts,
    diagnostics: withGatewayDiagnosticSubject(diagnostics, {
      api: { id: service.name },
    }),
    identityEvidence,
    authSummary,
    hasQuota,
  };
}
