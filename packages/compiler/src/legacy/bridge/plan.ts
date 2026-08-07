import type { z } from "zod";
import {
  LegacyCapabilityBinding,
  type LegacyCapabilityBinding as LegacyCapabilityBindingType,
} from "../refinement/model.js";
import {
  finalizeLegacyBridgePlan,
  type LegacyBridgeCapability,
  type LegacyBridgeConformanceCase,
  type LegacyBridgeDriverDescriptor,
  LegacyBridgeDriverDescriptor as LegacyBridgeDriverDescriptorSchema,
  type LegacyBridgePlan,
  LegacyBridgePlan as LegacyBridgePlanSchema,
  LegacyBridgeSupportAssessment,
} from "./model.js";

const BASE_CAPABILITIES: LegacyBridgeCapability[] = [
  "transport_client",
  "wire_serialization",
  "authorization",
  "timeout_and_cancellation",
  "stable_error_mapping",
  "completion_observation",
  "health_and_readiness",
  "telemetry",
  "recorded_conformance",
];

/**
 * Convert one approved, content-addressed binding into a non-executable bridge
 * contract. Planning proves required behavior; it never proves live readiness.
 */
export function planLegacyBridge(bindingInput: LegacyCapabilityBindingType): LegacyBridgePlan {
  const binding = LegacyCapabilityBinding.parse(bindingInput);
  const capabilities = new Set<LegacyBridgeCapability>(BASE_CAPABILITIES);
  if (binding.semantics.idempotency.mode === "client_key") {
    capabilities.add("idempotency_enforcement");
  }
  if (binding.semantics.retry.mode === "safe_transient") capabilities.add("bounded_retry");
  if (binding.transport.kind === "message" && binding.transport.reply.mode !== "none") {
    capabilities.add("reply_correlation");
  }

  return finalizeLegacyBridgePlan({
    schemaVersion: 1,
    bindingId: binding.bindingId,
    bindingContentHash: binding.contentHash,
    operationName: binding.operation.name,
    transport: binding.transport,
    semantics: binding.semantics,
    requiredCapabilities: [...capabilities].sort(),
    conformance: conformanceCases(binding, capabilities),
    unverifiedLiveFacts: [
      "business_completion_observable",
      "credentials_valid",
      "identity_authorized",
      "network_reachable",
      "runtime_compatible",
      "target_exists",
    ],
    executionAllowed: false,
  });
}

/** Evaluate an installed driver declaration without loading or executing it. */
export function assessLegacyBridgeDriver(
  planInput: LegacyBridgePlan,
  descriptorInput: LegacyBridgeDriverDescriptor,
): z.infer<typeof LegacyBridgeSupportAssessment> {
  const plan = LegacyBridgePlanSchema.parse(planInput);
  const descriptor = LegacyBridgeDriverDescriptorSchema.parse(descriptorInput);
  const transportSupported = descriptor.transports.some((transport) => {
    if (transport.kind !== plan.transport.kind) return false;
    if (transport.kind === "message" && plan.transport.kind === "message") {
      return transport.protocols.includes(plan.transport.protocol);
    }
    if (transport.kind === "remote_method" && plan.transport.kind === "remote_method") {
      return transport.protocols.includes(plan.transport.protocol);
    }
    return true;
  });
  const available = new Set(descriptor.capabilities);
  const missingCapabilities = plan.requiredCapabilities.filter(
    (capability) => !available.has(capability),
  );
  const reasons = [
    ...(!transportSupported
      ? [`Driver '${descriptor.id}' does not declare transport '${transportIdentity(plan)}'.`]
      : []),
    ...missingCapabilities.map(
      (capability) => `Driver '${descriptor.id}' is missing '${capability}'.`,
    ),
  ];
  return LegacyBridgeSupportAssessment.parse({
    schemaVersion: 1,
    planId: plan.planId,
    driverId: descriptor.id,
    supported: transportSupported && missingCapabilities.length === 0,
    missingCapabilities,
    reasons,
  });
}

function conformanceCases(
  binding: LegacyCapabilityBindingType,
  capabilities: ReadonlySet<LegacyBridgeCapability>,
): LegacyBridgeConformanceCase[] {
  const cases: LegacyBridgeConformanceCase[] = [
    testCase(
      "target_binding",
      "transport_client",
      `Use only reviewed target '${binding.transport.target}'.`,
    ),
    testCase(
      "wire_serialization",
      "wire_serialization",
      "Map the reviewed agent schema to the declared wire serialization without dropping required fields.",
    ),
    testCase(
      "authorization",
      "authorization",
      `Enforce reviewed authorization mode '${binding.semantics.authorization.mode}'.`,
    ),
    testCase(
      "timeout",
      "timeout_and_cancellation",
      `Terminate or cancel after ${binding.semantics.timeoutMs}ms without reporting business success.`,
    ),
    testCase(
      "stable_errors",
      "stable_error_mapping",
      "Map transport/application failures only to reviewed stable error codes.",
    ),
    testCase(
      "completion",
      "completion_observation",
      `Report no stronger completion state than '${binding.semantics.completion}'.`,
    ),
    testCase(
      "readiness",
      "health_and_readiness",
      "Readiness must fail until target reachability and authorization are verified.",
    ),
    testCase(
      "telemetry",
      "telemetry",
      "Emit operation, target, latency and outcome telemetry without payloads or secrets.",
    ),
    testCase(
      "recorded_fixture",
      "recorded_conformance",
      "Pass recorded request, refusal, timeout and error fixtures before live enablement.",
    ),
  ];
  if (capabilities.has("idempotency_enforcement")) {
    cases.push(
      testCase(
        "idempotency",
        "idempotency_enforcement",
        `Carry the reviewed idempotency key through '${binding.semantics.idempotency.carrier}'.`,
      ),
    );
  }
  if (capabilities.has("bounded_retry")) {
    cases.push(
      testCase(
        "bounded_retry",
        "bounded_retry",
        `Attempt no more than ${binding.semantics.retry.maxAttempts} total executions and retry only reviewed transient failures.`,
      ),
    );
  }
  if (capabilities.has("reply_correlation") && binding.transport.kind === "message") {
    cases.push(
      testCase(
        "reply_correlation",
        "reply_correlation",
        `Correlate replies using '${binding.transport.reply.correlationField ?? "reviewed transport correlation"}' and never consume an unrelated reply.`,
      ),
    );
  }
  return cases.sort((left, right) => left.id.localeCompare(right.id));
}

function testCase(
  id: string,
  capability: LegacyBridgeCapability,
  assertion: string,
): LegacyBridgeConformanceCase {
  return { id: `legacy-bridge/${id}`, capability, assertion, required: true };
}

function transportIdentity(plan: LegacyBridgePlan): string {
  if (plan.transport.kind === "message" || plan.transport.kind === "remote_method") {
    return `${plan.transport.kind}:${plan.transport.protocol}`;
  }
  return plan.transport.kind;
}
