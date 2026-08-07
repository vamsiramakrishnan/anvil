import { hashCanonical } from "@anvil/air";
import { z } from "zod";
import { LegacySha256 } from "../core/model.js";
import { LegacyCapabilityBinding } from "../refinement/model.js";

const bridgeText = (max = 2048) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value === value.trim(), "must not have surrounding whitespace");

export const LegacyBridgeCapability = z.enum([
  "transport_client",
  "wire_serialization",
  "authorization",
  "timeout_and_cancellation",
  "stable_error_mapping",
  "idempotency_enforcement",
  "bounded_retry",
  "reply_correlation",
  "completion_observation",
  "health_and_readiness",
  "telemetry",
  "recorded_conformance",
]);
export type LegacyBridgeCapability = z.infer<typeof LegacyBridgeCapability>;

export const LegacyBridgeDriverDescriptor = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    transports: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("message"), protocols: z.array(z.string()).min(1) }).strict(),
          z
            .object({ kind: z.literal("remote_method"), protocols: z.array(z.string()).min(1) })
            .strict(),
          z.object({ kind: z.literal("resource_adapter") }).strict(),
          z.object({ kind: z.literal("stored_procedure") }).strict(),
          z.object({ kind: z.literal("batch_job") }).strict(),
        ]),
      )
      .min(1),
    capabilities: z.array(LegacyBridgeCapability).min(1),
    deterministicGeneration: z.literal(true),
    liveDiscovery: z.literal(false),
    acceptsSecrets: z.literal(false),
  })
  .strict();
export type LegacyBridgeDriverDescriptor = z.infer<typeof LegacyBridgeDriverDescriptor>;

export interface LegacyBridgeDriver {
  readonly descriptor: LegacyBridgeDriverDescriptor;
}

export const LegacyBridgeConformanceCase = z
  .object({
    id: z.string().regex(/^legacy-bridge\/[a-z0-9_/-]+$/),
    capability: LegacyBridgeCapability,
    assertion: bridgeText(4096),
    required: z.boolean(),
  })
  .strict();
export type LegacyBridgeConformanceCase = z.infer<typeof LegacyBridgeConformanceCase>;

const LegacyBridgePlanCore = z
  .object({
    schemaVersion: z.literal(1),
    bindingId: z.string().regex(/^lcb_[0-9a-f]{64}$/),
    bindingContentHash: LegacySha256,
    operationName: bridgeText(128),
    transport: LegacyCapabilityBinding.shape.transport,
    semantics: LegacyCapabilityBinding.shape.semantics,
    requiredCapabilities: z.array(LegacyBridgeCapability).min(1),
    conformance: z.array(LegacyBridgeConformanceCase).min(1),
    unverifiedLiveFacts: z
      .array(
        z.enum([
          "target_exists",
          "network_reachable",
          "credentials_valid",
          "identity_authorized",
          "runtime_compatible",
          "business_completion_observable",
        ]),
      )
      .min(1),
    executionAllowed: z.literal(false),
  })
  .strict();

export const LegacyBridgePlan = LegacyBridgePlanCore.extend({
  planId: z.string().regex(/^lbp_[0-9a-f]{64}$/),
  contentHash: LegacySha256,
})
  .strict()
  .superRefine((record, ctx) => {
    const { planId: _planId, contentHash: _contentHash, ...core } = record;
    const digest = hashCanonical(core);
    if (record.planId !== `lbp_${digest}`) {
      ctx.addIssue({ code: "custom", path: ["planId"], message: "must match plan content" });
    }
    if (record.contentHash !== `sha256:${digest}`) {
      ctx.addIssue({ code: "custom", path: ["contentHash"], message: "must match plan content" });
    }
  });
export type LegacyBridgePlan = z.infer<typeof LegacyBridgePlan>;

export function finalizeLegacyBridgePlan(
  input: z.input<typeof LegacyBridgePlanCore>,
): LegacyBridgePlan {
  const core = LegacyBridgePlanCore.parse(input);
  const digest = hashCanonical(core);
  return LegacyBridgePlan.parse({
    ...core,
    planId: `lbp_${digest}`,
    contentHash: `sha256:${digest}`,
  });
}

export const LegacyBridgeSupportAssessment = z
  .object({
    schemaVersion: z.literal(1),
    planId: z.string().regex(/^lbp_[0-9a-f]{64}$/),
    driverId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    supported: z.boolean(),
    missingCapabilities: z.array(LegacyBridgeCapability),
    reasons: z.array(bridgeText(4096)),
  })
  .strict();
export type LegacyBridgeSupportAssessment = z.infer<typeof LegacyBridgeSupportAssessment>;
