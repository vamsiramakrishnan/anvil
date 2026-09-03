import { z } from "zod";
import type { AuthRequirement } from "./schema.js";

/**
 * The mechanics of the three auth schemes the runtime could not execute until
 * AIR could name what they need: authorization-code (endpoints + PKCE, the
 * interactive step in a local broker, never the serving path), mutual TLS
 * (client material by environment-variable NAME only — PEM never appears in
 * AIR, a bundle, a record, or a log), and custom-header carriers. `schema.ts`
 * owns the shapes those facts hang off; this module owns the facts and the
 * coherence rules that keep them from being declared on the wrong scheme.
 */

export const TlsClientMaterialRefs = z.object({
  clientCertRef: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  clientKeyRef: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  caRef: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .optional(),
});
export type TlsClientMaterialRefs = z.infer<typeof TlsClientMaterialRefs>;

/** Coherence rules for the mechanics above; `authCoherenceIssues` folds them in. */
export function authMechanicsIssues(auth: AuthRequirement): string[] {
  const issues: string[] = [];
  if (auth.type === "mtls" && !auth.tls) {
    issues.push("mtls auth must name its client certificate and key references");
  }
  if (auth.tls && auth.type !== "mtls") {
    issues.push(`${auth.type} auth cannot carry mtls client material references`);
  }
  const mechanics =
    auth.provider?.pkce !== undefined || auth.provider?.authorizationEndpoint !== undefined;
  if (mechanics && auth.type !== "oauth2_authorization_code") {
    issues.push(`${auth.type} auth cannot declare authorization-code mechanics`);
  }
  if (
    auth.type === "oauth2_authorization_code" &&
    auth.provider?.authorizationEndpoint &&
    !auth.provider.tokenEndpoint
  ) {
    issues.push(
      "authorization-code auth that names an authorization endpoint must name its token endpoint",
    );
  }
  return issues;
}
