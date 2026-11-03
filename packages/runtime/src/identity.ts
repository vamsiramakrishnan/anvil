import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { IdentityProfile, type Operation } from "@anvil/air";
import type { InboundIdentity } from "./inbound-identity.js";
import type { Principal } from "./policy.js";

export interface EnterprisePrincipal extends Principal {
  identity: {
    issuer: string;
    subject: string;
    tenant: string;
    expiresAt: number;
    groups: string[];
    scopes: string[];
    actor?: string;
  };
}
export interface AuthorizationContext {
  principal: EnterprisePrincipal;
  service: string;
  operation: Operation;
  input: Readonly<Record<string, unknown>>;
  confirmed: boolean;
  traceId: string;
  signal: AbortSignal;
}
export type AuthorizationDecision = {
  allowed: boolean;
  reason: string;
  policyVersion: string;
  /** Only supported obligation; unknown obligations are rejected at runtime. */
  obligations?: { kind: "confirmation" }[];
};
export type IdentityAuthorizer = (context: AuthorizationContext) => Promise<AuthorizationDecision>;
/** Parse once per boot. No tokens or secrets belong in this file. */
export function loadIdentityProfile(
  env: NodeJS.ProcessEnv = process.env,
): IdentityProfile | undefined {
  const path = env.ANVIL_IDENTITY_PROFILE;
  const inline = env.ANVIL_IDENTITY_PROFILE_JSON;
  if (path === undefined && inline === undefined) return undefined;
  if (path !== undefined && inline !== undefined)
    throw new Error("Configure one identity profile source");
  if (path !== undefined && !path.trim())
    throw new Error("ANVIL_IDENTITY_PROFILE must name a JSON profile");
  const bytes = inline !== undefined ? Buffer.from(inline) : readFileSync(path as string);
  if (bytes.length > 1024 * 1024) throw new Error("Identity profile exceeds 1 MiB");
  return IdentityProfile.parse(JSON.parse(bytes.toString("utf8")));
}
export function identityProfileDigest(profile: IdentityProfile): string {
  return createHash("sha256")
    .update(JSON.stringify(IdentityProfile.parse(profile)))
    .digest("hex");
}
function strings(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return undefined;
}
export function mapIdentity(
  profile: IdentityProfile,
  inbound: InboundIdentity | undefined,
  now = Date.now(),
): EnterprisePrincipal | undefined {
  const c = inbound?.claims;
  if (
    !c ||
    c.iss !== profile.authentication.issuer ||
    typeof c.sub !== "string" ||
    !c.sub ||
    typeof c.exp !== "number" ||
    !Number.isFinite(c.exp) ||
    c.exp * 1000 <= now
  )
    return undefined;
  const audiences = typeof c.aud === "string" ? [c.aud] : c.aud;
  if (!Array.isArray(audiences) || !audiences.includes(profile.authentication.audience))
    return undefined;
  if (profile.mapping.subjects && !profile.mapping.subjects.includes(c.sub)) return undefined;
  const mapping = profile.mapping.tenant;
  const tenant = mapping.source === "fixed" ? mapping.value : c[mapping.claim];
  if (
    typeof tenant !== "string" ||
    !tenant ||
    (mapping.source === "claim" && !mapping.allowed.includes(tenant))
  )
    return undefined;
  const groups = strings(profile.mapping.groupsClaim ? c[profile.mapping.groupsClaim] : undefined);
  const scopes = strings(c.scope ?? c.scp);
  if (!groups || !scopes) return undefined;
  return {
    id: `identity:${createHash("sha256")
      .update(JSON.stringify([c.iss, tenant, c.sub]))
      .digest("hex")}`,
    scopes: [...profile.mapping.upstreamScopes],
    identity: {
      issuer: c.iss as string,
      subject: c.sub,
      tenant,
      expiresAt: c.exp * 1000,
      groups,
      scopes,
      ...(typeof c.azp === "string"
        ? { actor: c.azp }
        : typeof c.client_id === "string"
          ? { actor: c.client_id }
          : {}),
    },
  };
}

export interface IdentityRuntime {
  profile: IdentityProfile;
  digest: string;
  principalFor(inbound: InboundIdentity | undefined): EnterprisePrincipal | undefined;
  authorize(context: Omit<AuthorizationContext, "signal">): Promise<AuthorizationDecision>;
}
export function createIdentityRuntime(
  raw: IdentityProfile,
  adapters: Readonly<Record<string, IdentityAuthorizer>> = {},
): IdentityRuntime {
  const profile = IdentityProfile.parse(raw);
  const digest = identityProfileDigest(profile);
  const adapter =
    profile.authorization.adapter === "rules"
      ? undefined
      : Object.hasOwn(adapters, profile.authorization.adapter)
        ? adapters[profile.authorization.adapter]
        : undefined;
  if (profile.authorization.adapter !== "rules" && !adapter)
    throw new Error("Configured identity authorizer is not registered");
  const deny = (): AuthorizationDecision => ({
    allowed: false,
    reason: "identity_denied",
    policyVersion: digest,
  });
  return {
    profile,
    digest,
    principalFor: (inbound) => mapIdentity(profile, inbound),
    async authorize(context) {
      if (context.principal.identity.expiresAt <= Date.now()) return deny();
      if (!adapter) {
        const matches = profile.authorization.rules.filter(
          (rule) =>
            rule.service === context.service &&
            rule.operations.includes(context.operation.id) &&
            (!rule.subjects || rule.subjects.includes(context.principal.identity.subject)) &&
            (!rule.groups ||
              rule.groups.some((group) => context.principal.identity.groups.includes(group))) &&
            (!rule.scopes ||
              rule.scopes.every((scope) => context.principal.identity.scopes.includes(scope))) &&
            rule.constraints.every((constraint) =>
              constraint.kind === "tenant_equals"
                ? Object.hasOwn(context.input, constraint.input) &&
                  context.input[constraint.input] === context.principal.identity.tenant
                : typeof context.input[constraint.input] === "number" &&
                  Number.isFinite(context.input[constraint.input]) &&
                  (context.input[constraint.input] as number) <= constraint.maximum,
            ),
        );
        if (matches.some((rule) => rule.effect === "deny")) return deny();
        const allow = matches.filter((rule) => rule.effect === "allow");
        if (!allow.length) return deny();
        return {
          allowed: true,
          reason: "identity_allowed",
          policyVersion: digest,
          obligations: allow.some((rule) => rule.requireConfirmation)
            ? [{ kind: "confirmation" }]
            : [],
        };
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Authorization timed out"));
          }, profile.authorization.timeoutMs);
        });
        // Extensions receive detached, secret-free values; mutation cannot rewrite the invocation.
        const decision = await Promise.race([
          adapter({ ...structuredClone(context), signal: controller.signal }),
          timeout,
        ]);
        if (
          !decision ||
          typeof decision.allowed !== "boolean" ||
          typeof decision.reason !== "string" ||
          !/^[a-zA-Z0-9_.:-]{1,128}$/.test(decision.reason) ||
          typeof decision.policyVersion !== "string" ||
          !/^[a-zA-Z0-9_.:-]{1,128}$/.test(decision.policyVersion) ||
          (decision.obligations !== undefined &&
            (!Array.isArray(decision.obligations) ||
              decision.obligations.some(
                (item) => item?.kind !== "confirmation" || Object.keys(item).length !== 1,
              )))
        )
          return deny();
        return decision;
      } catch {
        return deny();
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
