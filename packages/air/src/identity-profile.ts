import { z } from "zod";

const text = z.string().trim().min(1).max(2048);
const https = text.refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}, "Expected an HTTPS URL without credentials or fragment");
const claim = text.refine(
  (value) => !["__proto__", "constructor", "prototype"].includes(value),
  "Invalid claim key",
);

/** Deployment-owned, reusable across bundles. Never inferred from upstream auth. */
export const IdentityProfile = z
  .strictObject({
    version: z.literal(1),
    id: text,
    authentication: z.strictObject({
      provider: z.enum(["oidc", "google_service_account", "google_iap", "jwt_bridge"]),
      issuer: https,
      audience: text,
      jwksUri: https,
      resource: https.optional(),
      requiredScopes: z.array(text).default([]),
      /** JWT access-token profiles can require at+jwt; Google assertions use JWT. */
      tokenType: z.enum(["at+jwt", "JWT"]).optional(),
    }),
    mapping: z.strictObject({
      tenant: z.discriminatedUnion("source", [
        z.strictObject({ source: z.literal("fixed"), value: text }),
        z.strictObject({ source: z.literal("claim"), claim, allowed: z.array(text).min(1) }),
      ]),
      groupsClaim: claim.optional(),
      /** Reviewed upstream scopes, separate from inbound OAuth scopes. No wildcard default. */
      upstreamScopes: z.array(text).default([]),
      subjects: z.array(text).min(1).optional(),
    }),
    authorization: z.strictObject({
      adapter: text.default("rules"),
      timeoutMs: z.number().int().min(1).max(30000).default(3000),
      rules: z
        .array(
          z.strictObject({
            id: text,
            service: text,
            operations: z.array(text).min(1),
            effect: z.enum(["allow", "deny"]),
            subjects: z.array(text).min(1).optional(),
            groups: z.array(text).min(1).optional(),
            scopes: z.array(text).optional(),
            /** Inputs are requests, not ownership evidence. This only constrains their values. */
            constraints: z
              .array(
                z.discriminatedUnion("kind", [
                  z.strictObject({ kind: z.literal("tenant_equals"), input: text }),
                  z.strictObject({
                    kind: z.literal("number_max"),
                    input: text,
                    maximum: z.number().finite(),
                  }),
                ]),
              )
              .default([]),
            requireConfirmation: z.boolean().default(false),
          }),
        )
        .default([]),
    }),
  })
  .superRefine((profile, ctx) => {
    const auth = profile.authentication;
    if (
      auth.provider === "google_service_account" &&
      (auth.issuer !== "https://accounts.google.com" ||
        auth.jwksUri !== "https://www.googleapis.com/oauth2/v3/certs")
    )
      ctx.addIssue({ code: "custom", message: "Google service-account issuer and JWKS are fixed" });
    if (
      auth.provider === "google_iap" &&
      (auth.issuer !== "https://cloud.google.com/iap" ||
        auth.jwksUri !== "https://www.gstatic.com/iap/verify/public_key-jwk")
    )
      ctx.addIssue({ code: "custom", message: "IAP issuer and JWKS are fixed" });
    if (!auth.resource && !auth.audience.startsWith("https://"))
      ctx.addIssue({
        code: "custom",
        message: "A non-URL audience requires the public resource URL",
      });
    if (auth.provider === "google_service_account" && !profile.mapping.subjects?.length)
      ctx.addIssue({
        code: "custom",
        message: "Google service-account profiles require an explicit subject allowlist",
      });
    const ids = profile.authorization.rules.map((rule) => rule.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "Authorization rule IDs must be unique" });
    if (profile.authorization.adapter !== "rules" && ids.length)
      ctx.addIssue({
        code: "custom",
        message: "Custom adapters cannot silently ignore local rules",
      });
  });
export type IdentityProfile = z.infer<typeof IdentityProfile>;

/** Editor schema; cross-field provider constraints remain enforced by IdentityProfile. */
export function identityProfileJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(IdentityProfile, { target: "draft-2020-12", io: "input" });
}
