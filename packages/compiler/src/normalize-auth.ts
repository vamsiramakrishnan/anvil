import { createHash } from "node:crypto";
import { type AuthRequirement, type AuthType, snakeCase } from "@anvil/air";
import { authEndpoint } from "./auth-endpoint.js";
import { classifyAuth } from "./classify.js";
import type { OpenApiDocument, SecurityScheme } from "./parse.js";

interface AuthResolution {
  auth: AuthRequirement;
  issue?: { code: string; message: string; blocked?: boolean };
}

function authOf(
  type: AuthType,
  scopes: string[],
  provider?: AuthRequirement["provider"],
  credentialProfile?: string,
): AuthRequirement {
  const { principal, secretSource } = classifyAuth(type);
  return {
    type,
    scopes,
    principal,
    secretSource,
    ...(provider ? { provider } : {}),
    ...(credentialProfile ? { credentialProfile } : {}),
  };
}

function credentialProfileFor(schemeName: string): string {
  const normalized = snakeCase(schemeName) || "scheme";
  const rooted = /^[a-z]/.test(normalized) ? normalized : `scheme_${normalized}`;
  // Always retain a cryptographic suffix. Distinct source names such as
  // `Partner-OAuth` and `partner_oauth` normalize to the same readable slug;
  // aliasing those schemes would make them share upstream secrets.
  const digest = createHash("sha256").update(schemeName).digest("hex").slice(0, 32);
  const prefix = rooted.slice(0, 31).replace(/_+$/, "") || "scheme";
  return `${prefix}_${digest}`;
}

function unresolvedAuth(
  scopes: string[],
  code: string,
  message: string,
  blocked = false,
  credentialProfile?: string,
): AuthResolution {
  return {
    auth: authOf("custom_header", scopes, undefined, credentialProfile),
    issue: { code, message, blocked },
  };
}

function oauthAuth(
  doc: OpenApiDocument,
  schemeName: string,
  scheme: SecurityScheme,
  scopes: string[],
): AuthResolution {
  const credentialProfile = credentialProfileFor(schemeName);
  const flows = Object.entries(scheme.flows ?? {}).filter(([, flow]) => flow !== undefined);
  if (flows.length === 0 && scheme.flow) {
    flows.push([
      scheme.flow,
      {
        tokenUrl: scheme.tokenUrl,
        authorizationUrl: scheme.authorizationUrl,
      },
    ]);
  }
  if (flows.length !== 1) {
    return unresolvedAuth(
      scopes,
      "auth/oauth_flow_ambiguous",
      `OAuth security declares ${flows.length} flows; AIR requires one explicit principal/grant. Select it in the manifest before approval.`,
      true,
      credentialProfile,
    );
  }
  const [name, flow] = flows[0] as [string, NonNullable<SecurityScheme["flows"]>[string]];
  const declaredEndpoint = flow.tokenUrl ?? scheme.tokenUrl;
  const tokenEndpoint = declaredEndpoint ? authEndpoint(doc, declaredEndpoint) : undefined;
  if (declaredEndpoint && !tokenEndpoint) {
    return unresolvedAuth(
      scopes,
      "auth/oauth_flow_unsupported",
      "OAuth token URL cannot be resolved against the declared default server. Supply an explicit token endpoint before approval.",
      true,
      credentialProfile,
    );
  }
  if (name === "clientCredentials" || name === "application") {
    return {
      auth: authOf(
        "oauth2_client_credentials",
        scopes,
        {
          grant: "client_credentials",
          ...(tokenEndpoint ? { tokenEndpoint } : {}),
        },
        credentialProfile,
      ),
    };
  }
  if (name === "authorizationCode" || name === "accessCode" || name === "implicit") {
    return {
      auth: authOf(
        "oauth2_authorization_code",
        scopes,
        tokenEndpoint ? { tokenEndpoint } : undefined,
        credentialProfile,
      ),
      issue: {
        code: "auth/end_user_flow_unexecutable",
        message:
          "End-user OAuth cannot use one shared runtime token. Two ways to make this concrete: " +
          "model per-caller delegation in the manifest — `auth: { type: oauth2_on_behalf_of }` " +
          "— and the runtime will exchange each caller's inbound token (RFC 8693 token exchange; " +
          "the imported token endpoint is preserved); or run `anvil auth login <bundle> " +
          "--profile <profile>` once to complete the interactive PKCE step and store a refresh " +
          "token the runtime replays/refreshes per call. Either way this stays review_required " +
          "— end-user authority is a human decision, not a material-completeness one — until " +
          "approved.",
        blocked: false,
      },
    };
  }
  return unresolvedAuth(
    scopes,
    "auth/oauth_flow_unsupported",
    `OAuth flow "${name}" is not executable by the runtime. Enrich an explicit supported auth type/provider before approval.`,
    true,
    credentialProfile,
  );
}

export function resolveAuth(
  doc: OpenApiDocument,
  opSecurity: Array<Record<string, string[]>> | undefined,
): AuthResolution {
  const security = opSecurity ?? doc.security ?? [];
  if (security.length > 1) return resolveAlternatives(doc, security);
  return resolveSingleRequirement(doc, security[0]);
}

/**
 * OR'd security alternatives. AIR still refuses to *guess* between authorities,
 * but when every credentialed alternative resolves cleanly to the SAME
 * principal class — e.g. Stripe's basic-OR-bearer for one API key, Coupa's
 * client-credentials-OR-api-key service identity — the choice carries no
 * safety weight: whichever carrier is used, the call runs under the same
 * authority. Selecting the first alternative then trades a wholesale-blocked
 * estate for a review_required one with an explicit note, and the human
 * approving the operation sees exactly what was picked and what was bypassed.
 * Any disagreement in principal, or any alternative that does not itself
 * resolve cleanly, keeps the conservative block.
 */
function resolveAlternatives(
  doc: OpenApiDocument,
  security: Array<Record<string, string[]>>,
): AuthResolution {
  const credentialed = security.filter((s) => Object.keys(s).length > 0);
  if (credentialed.length === 0) return { auth: authOf("none", []) };
  const anonymousAllowed = credentialed.length < security.length;
  const resolutions = credentialed.map((s) => resolveSingleRequirement(doc, s));
  const principals = new Set(resolutions.map((r) => r.auth.principal));
  const equivalent = resolutions.every((r) => !r.issue) && principals.size === 1;
  if (!equivalent) {
    return unresolvedAuth(
      [],
      "auth/alternatives_unmodeled",
      `OpenAPI declares ${security.length} alternative security requirements (OR). AIR cannot safely select one implicitly; choose an explicit auth contract in the manifest.`,
      true,
    );
  }
  const chosen = resolutions[0] as AuthResolution;
  const names = credentialed.map((s) => Object.keys(s).join("+"));
  const bypassed = names.slice(1).map((n) => `"${n}"`);
  return {
    auth: chosen.auth,
    issue: {
      code: "auth/alternative_selected",
      message:
        `OpenAPI declares ${security.length} alternative security requirements (OR) that all ` +
        `carry ${chosen.auth.principal} authority and differ only in credential carrier. ` +
        `Compiled the first ("${names[0]}"), bypassing ${bypassed.join(", ")}` +
        `${anonymousAllowed ? " and an anonymous alternative" : ""}. ` +
        `Override auth in the manifest to select a different carrier.`,
    },
  };
}

function resolveSingleRequirement(
  doc: OpenApiDocument,
  requirement: Record<string, string[]> | undefined,
): AuthResolution {
  const schemes = doc.components?.securitySchemes ?? {};
  const first = requirement;
  if (!first || Object.keys(first).length === 0) {
    return { auth: authOf("none", []) };
  }
  const entries = Object.entries(first);
  if (entries.length > 1) {
    return unresolvedAuth(
      [...new Set(entries.flatMap(([, scopes]) => scopes))],
      "auth/composite_unmodeled",
      `OpenAPI requires ${entries.length} security schemes together (AND). AIR currently models one credential; enrich a composite auth contract before approval.`,
      true,
    );
  }
  const [schemeName, scopes] = entries[0] as [string, string[]];
  const credentialProfile = credentialProfileFor(schemeName);
  const scheme: SecurityScheme | undefined = schemes[schemeName];
  if (!scheme) {
    return unresolvedAuth(
      scopes ?? [],
      "auth/scheme_missing",
      `Security scheme "${schemeName}" is referenced but not defined.`,
      false,
      credentialProfile,
    );
  }
  if (scheme.type === "http") {
    if (scheme.scheme === "basic") {
      return { auth: authOf("basic", scopes ?? [], undefined, credentialProfile) };
    }
    if (scheme.scheme === "bearer") {
      return { auth: authOf("jwt_bearer", scopes ?? [], undefined, credentialProfile) };
    }
    return unresolvedAuth(
      scopes ?? [],
      "auth/http_scheme_unsupported",
      `HTTP auth scheme "${scheme.scheme ?? "unknown"}" is not modeled.`,
      false,
      credentialProfile,
    );
  }
  if (scheme.type === "apiKey") {
    if ((scheme.in === "header" || scheme.in === "query") && scheme.name) {
      return {
        auth: authOf(
          "api_key",
          scopes ?? [],
          {
            apiKey: { in: scheme.in, name: scheme.name },
          },
          credentialProfile,
        ),
      };
    }
    return unresolvedAuth(
      scopes ?? [],
      "auth/api_key_carrier_missing",
      `API key scheme "${schemeName}" does not declare a supported header/query carrier.`,
      false,
      credentialProfile,
    );
  }
  if (scheme.type === "oauth2") return oauthAuth(doc, schemeName, scheme, scopes ?? []);
  if (scheme.type === "openIdConnect") {
    return {
      auth: authOf("oauth2_authorization_code", scopes ?? [], undefined, credentialProfile),
      issue: {
        code: "auth/end_user_flow_unexecutable",
        message:
          "OpenID Connect end-user auth needs per-caller token propagation/exchange; a shared " +
          "runtime bearer is forbidden. Two ways to make this concrete: model per-caller " +
          "delegation in the manifest — `auth: { type: oauth2_on_behalf_of, provider: { " +
          "token_endpoint: <STS URL> } }` — and the runtime will exchange each caller's inbound " +
          "token (RFC 8693); or run `anvil auth login <bundle> --profile <profile>` once to " +
          "complete the interactive PKCE step and store a refresh token the runtime replays/" +
          "refreshes per call. Either way this stays review_required — end-user authority is a " +
          "human decision, not a material-completeness one — until approved.",
        blocked: false,
      },
    };
  }
  if (scheme.type === "mutualTLS") {
    return { auth: authOf("mtls", scopes ?? [], undefined, credentialProfile) };
  }
  return unresolvedAuth(
    scopes ?? [],
    "auth/scheme_unsupported",
    `Security scheme "${schemeName}" has unsupported type "${scheme.type ?? "unknown"}".`,
    false,
    credentialProfile,
  );
}
