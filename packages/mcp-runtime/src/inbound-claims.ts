import type { InboundClaims } from "./inbound-auth.js";

/** Shared claim shapes and scope rules for JWT and online introspection verification. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

export function validClaimsShape(claims: Record<string, unknown>): claims is InboundClaims {
  const optionalStrings = ["iss", "sub", "scope", "email"] as const;
  if (optionalStrings.some((key) => claims[key] !== undefined && typeof claims[key] !== "string")) {
    return false;
  }
  for (const key of ["exp", "nbf"] as const) {
    if (
      claims[key] !== undefined &&
      (typeof claims[key] !== "number" || !Number.isFinite(claims[key]))
    ) {
      return false;
    }
  }
  const validStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  if (claims.aud !== undefined && typeof claims.aud !== "string" && !validStringArray(claims.aud)) {
    return false;
  }
  if (claims.scp !== undefined && typeof claims.scp !== "string" && !validStringArray(claims.scp)) {
    return false;
  }
  return true;
}

export function audienceMatches(aud: string | string[] | undefined, expected: string): boolean {
  if (aud === undefined) return false;
  return Array.isArray(aud) ? aud.includes(expected) : aud === expected;
}

function tokenScopes(claims: InboundClaims): Set<string> {
  const out = new Set<string>();
  if (typeof claims.scope === "string")
    for (const s of claims.scope.split(/\s+/)) if (s) out.add(s);
  if (Array.isArray(claims.scp)) for (const s of claims.scp) out.add(s);
  else if (typeof claims.scp === "string")
    for (const s of claims.scp.split(/\s+/)) if (s) out.add(s);
  return out;
}

export function missingScopes(claims: InboundClaims, required: string[] | undefined): string[] {
  if (!required || required.length === 0) return [];
  const have = tokenScopes(claims);
  return required.filter((s) => !have.has(s));
}
