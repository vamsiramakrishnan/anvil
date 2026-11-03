import { IdentityProfile } from "@anvil/air";
import { z } from "zod";

/** Identity configuration is deployment-owned and never contains live credentials. */
export const zIdentityIssue = z.object({ path: z.string(), message: z.string() });

export const zIdentityView = z.object({
  bundleId: z.string(),
  bundleHash: z.string(),
  configured: z.boolean(),
  profile: IdentityProfile.optional(),
  profileDigest: z.string().optional(),
  integrity: z.object({
    state: z.enum(["missing", "fresh", "stale", "invalid"]),
    findings: z.array(z.string()),
  }),
  verifiedLive: z.literal(false),
  files: z.array(z.string()),
});

/** Unknown profile input is deliberately parsed by the shared library for positioned issues. */
export const zIdentityDraftRequest = z.strictObject({
  bundleHash: z.string().min(1),
  profile: z.unknown(),
});

export const zIdentityValidation = z.object({
  bundleId: z.string(),
  bundleHash: z.string(),
  ok: z.boolean(),
  issues: z.array(zIdentityIssue),
  profile: IdentityProfile.optional(),
  profileDigest: z.string().optional(),
  files: z.array(z.string()),
});

export const zIdentityApplyResponse = z.object({
  written: z.literal(true),
  identity: zIdentityView,
  warnings: z.array(z.string()),
});

export const IDENTITY_ROUTES = {
  identity: {
    method: "GET",
    path: "/api/bundles/:id/identity",
    mutates: false,
    response: zIdentityView,
  },
  validateIdentity: {
    method: "POST",
    path: "/api/bundles/:id/identity/validate",
    mutates: true,
    request: zIdentityDraftRequest,
    response: zIdentityValidation,
  },
  applyIdentity: {
    method: "POST",
    path: "/api/bundles/:id/identity",
    mutates: true,
    request: zIdentityDraftRequest,
    response: zIdentityApplyResponse,
  },
} as const;
