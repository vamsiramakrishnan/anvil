import { hashCanonical } from "@anvil/air";
import { z } from "zod";

export const LEGACY_MAX_RECORDS = 100_000;
export const LEGACY_MAX_CLAIMS = 256;
export const LEGACY_MAX_REFERENCES = 512;

const boundedText = (max = 512) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value === value.trim(), "must not have surrounding whitespace")
    .refine(
      (value) =>
        [...value].every((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint > 31 && codePoint !== 127;
        }),
      "must not contain control characters",
    );

export const LegacySha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export type LegacySha256 = z.infer<typeof LegacySha256>;

export const LegacyIdentifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);

export const LegacyRelativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      !/^[A-Za-z]:/.test(path) &&
      !path.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
    "must be a safe relative POSIX path",
  );

export const EvidenceSourceKind = z.enum([
  "deployed_artifact",
  "deployed_configuration",
  "broker_configuration",
  "artifact_repository",
  "source_repository",
  "runtime_observation",
  "operator_attestation",
  "service_catalog",
  "documentation",
  "naming_inference",
]);
export type EvidenceSourceKind = z.infer<typeof EvidenceSourceKind>;

export const LegacyArtifactRole = z.enum([
  "application_binary",
  "deployment_descriptor",
  "runtime_configuration",
  "broker_export",
  "schema",
  "source_manifest",
  "build_provenance",
  "runtime_observation",
  "ownership_record",
  "documentation",
  "other",
]);
export type LegacyArtifactRole = z.infer<typeof LegacyArtifactRole>;

const LegacyArtifactCore = z
  .object({
    schemaVersion: z.literal(1),
    digest: LegacySha256,
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    mediaType: boundedText(255).optional(),
    role: LegacyArtifactRole,
    path: LegacyRelativePath,
    source: z
      .object({
        kind: EvidenceSourceKind,
        systemId: LegacyIdentifier,
        revision: boundedText(512).optional(),
      })
      .strict(),
  })
  .strict();

export const LegacyArtifactInput = LegacyArtifactCore;
export type LegacyArtifactInput = z.infer<typeof LegacyArtifactInput>;

function addressed<T extends object>(
  prefix: string,
  core: T,
): T & {
  recordHash: LegacySha256;
  id: string;
} {
  const hex = hashCanonical(core);
  return { ...core, recordHash: `sha256:${hex}`, id: `${prefix}_${hex}` };
}

export const LegacyArtifactRecord = LegacyArtifactCore.extend({
  artifactId: z.string().regex(/^la_[0-9a-f]{64}$/),
  recordHash: LegacySha256,
})
  .strict()
  .superRefine((record, ctx) => {
    const { artifactId: _artifactId, recordHash: _recordHash, ...core } = record;
    const expected = addressed("la", core);
    if (record.artifactId !== expected.id) {
      ctx.addIssue({ code: "custom", path: ["artifactId"], message: "must match record content" });
    }
    if (record.recordHash !== expected.recordHash) {
      ctx.addIssue({ code: "custom", path: ["recordHash"], message: "must match record content" });
    }
  });
export type LegacyArtifactRecord = z.infer<typeof LegacyArtifactRecord>;

export function createLegacyArtifact(input: LegacyArtifactInput): LegacyArtifactRecord {
  const core = LegacyArtifactInput.parse(input);
  const result = addressed("la", core);
  return LegacyArtifactRecord.parse({
    ...core,
    artifactId: result.id,
    recordHash: result.recordHash,
  });
}

export const LegacyEvidenceBasis = z.enum(["declared", "configured", "observed", "inferred"]);
export type LegacyEvidenceBasis = z.infer<typeof LegacyEvidenceBasis>;

export const LegacyEvidenceCoordinate = z
  .object({
    path: LegacyRelativePath,
    pointer: boundedText(2048).optional(),
    span: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
      })
      .strict()
      .refine((span) => span.end >= span.start, "span end must be at or after start")
      .optional(),
  })
  .strict();
export type LegacyEvidenceCoordinate = z.infer<typeof LegacyEvidenceCoordinate>;

const LegacyEvidenceCore = z
  .object({
    schemaVersion: z.literal(1),
    artifactId: z.string().regex(/^la_[0-9a-f]{64}$/),
    sourceKind: EvidenceSourceKind,
    collectorId: LegacyIdentifier,
    basis: LegacyEvidenceBasis,
    coordinate: LegacyEvidenceCoordinate,
  })
  .strict();

export const LegacyEvidenceInput = LegacyEvidenceCore;
export type LegacyEvidenceInput = z.infer<typeof LegacyEvidenceInput>;

export const LegacyEvidenceRecord = LegacyEvidenceCore.extend({
  evidenceId: z.string().regex(/^le_[0-9a-f]{64}$/),
  recordHash: LegacySha256,
})
  .strict()
  .superRefine((record, ctx) => {
    const { evidenceId: _evidenceId, recordHash: _recordHash, ...core } = record;
    const expected = addressed("le", core);
    if (record.evidenceId !== expected.id) {
      ctx.addIssue({ code: "custom", path: ["evidenceId"], message: "must match record content" });
    }
    if (record.recordHash !== expected.recordHash) {
      ctx.addIssue({ code: "custom", path: ["recordHash"], message: "must match record content" });
    }
  });
export type LegacyEvidenceRecord = z.infer<typeof LegacyEvidenceRecord>;

export function createLegacyEvidence(input: LegacyEvidenceInput): LegacyEvidenceRecord {
  const core = LegacyEvidenceInput.parse(input);
  const result = addressed("le", core);
  return LegacyEvidenceRecord.parse({
    ...core,
    evidenceId: result.id,
    recordHash: result.recordHash,
  });
}

export const LegacyDeploymentCoordinate = z
  .object({
    environment: LegacyIdentifier,
    platform: LegacyIdentifier,
    application: LegacyIdentifier,
    module: LegacyIdentifier,
    component: LegacyIdentifier,
    deploymentDigest: LegacySha256,
  })
  .strict();
export type LegacyDeploymentCoordinate = z.infer<typeof LegacyDeploymentCoordinate>;

const InvocationText = boundedText(512);

export const LegacyInvocation = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("message"),
      protocol: z.enum(["jms", "ibm_mq", "amqp", "kafka", "artemis", "msmq", "other"]),
      /** Stable logical destination reference; physical bindings are binding_target claims. */
      destination: InvocationText,
      /** Destination-only exports cannot prove direction; unknown is not a wildcard. */
      direction: z.enum(["produce", "consume", "request_reply", "publish", "subscribe", "unknown"]),
      messageType: InvocationText.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("remote_method"),
      protocol: z.enum(["ejb_rmi", "wcf", "rmi", "com_plus", "other"]),
      endpointRef: InvocationText.optional(),
      interface: InvocationText,
      /** Archive/configuration evidence may prove only the remote interface. */
      method: InvocationText.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("resource_adapter"),
      adapterRef: InvocationText,
      connectionFactoryRef: InvocationText,
      interactionSpec: InvocationText.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("stored_procedure"),
      databaseRef: InvocationText,
      procedure: InvocationText,
    })
    .strict(),
  z
    .object({
      kind: z.literal("batch_job"),
      schedulerRef: InvocationText,
      job: InvocationText,
    })
    .strict(),
]);
export type LegacyInvocation = z.infer<typeof LegacyInvocation>;

export const LegacyClaimDimension = z.enum([
  "technical_name",
  "binding_target",
  "input_schema",
  "output_schema",
  "interaction_pattern",
  "delivery_guarantee",
  "transaction_boundary",
  "idempotency",
  "owner",
  "business_operation",
  "business_effect",
  "error_semantics",
]);
export type LegacyClaimDimension = z.infer<typeof LegacyClaimDimension>;

export const LegacyClaimValue = z.union([
  boundedText(2048),
  z.number().finite(),
  z.boolean(),
  z.array(boundedText(512)).min(1).max(64),
]);
export type LegacyClaimValue = z.infer<typeof LegacyClaimValue>;

export const LegacyClaim = z
  .object({
    dimension: LegacyClaimDimension,
    value: LegacyClaimValue,
    basis: LegacyEvidenceBasis,
    evidenceIds: z
      .array(z.string().regex(/^le_[0-9a-f]{64}$/))
      .min(1)
      .max(LEGACY_MAX_REFERENCES),
  })
  .strict();
export type LegacyClaim = z.infer<typeof LegacyClaim>;

const LegacyCapabilityObservationCore = z
  .object({
    schemaVersion: z.literal(1),
    collectorId: LegacyIdentifier,
    coordinate: LegacyDeploymentCoordinate,
    invocation: LegacyInvocation,
    claims: z.array(LegacyClaim).max(LEGACY_MAX_CLAIMS),
    evidenceIds: z
      .array(z.string().regex(/^le_[0-9a-f]{64}$/))
      .min(1)
      .max(LEGACY_MAX_REFERENCES),
  })
  .strict()
  .superRefine((observation, ctx) => {
    const owned = new Set(observation.evidenceIds);
    observation.claims.forEach((claim, claimIndex) => {
      claim.evidenceIds.forEach((evidenceId, evidenceIndex) => {
        if (!owned.has(evidenceId)) {
          ctx.addIssue({
            code: "custom",
            path: ["claims", claimIndex, "evidenceIds", evidenceIndex],
            message: "claim evidence must also be listed on the observation",
          });
        }
      });
    });
  });

export const LegacyCapabilityObservationInput = LegacyCapabilityObservationCore;
export type LegacyCapabilityObservationInput = z.infer<typeof LegacyCapabilityObservationInput>;

export const LegacyCapabilityObservation = z
  .object({
    schemaVersion: z.literal(1),
    observationId: z.string().regex(/^lo_[0-9a-f]{64}$/),
    recordHash: LegacySha256,
    collectorId: LegacyIdentifier,
    coordinate: LegacyDeploymentCoordinate,
    invocation: LegacyInvocation,
    claims: z.array(LegacyClaim).max(LEGACY_MAX_CLAIMS),
    evidenceIds: z
      .array(z.string().regex(/^le_[0-9a-f]{64}$/))
      .min(1)
      .max(LEGACY_MAX_REFERENCES),
  })
  .strict()
  .superRefine((record, ctx) => {
    const { observationId: _observationId, recordHash: _recordHash, ...core } = record;
    const coreResult = LegacyCapabilityObservationCore.safeParse(core);
    if (!coreResult.success) {
      ctx.addIssue({
        code: "custom",
        message: coreResult.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; "),
      });
      return;
    }
    const expected = addressed("lo", coreResult.data);
    if (record.observationId !== expected.id) {
      ctx.addIssue({
        code: "custom",
        path: ["observationId"],
        message: "must match record content",
      });
    }
    if (record.recordHash !== expected.recordHash) {
      ctx.addIssue({ code: "custom", path: ["recordHash"], message: "must match record content" });
    }
  });
export type LegacyCapabilityObservation = z.infer<typeof LegacyCapabilityObservation>;

function normalizeClaimValue(value: LegacyClaimValue): LegacyClaimValue {
  return Array.isArray(value) ? [...new Set(value)].sort() : value;
}

export function createLegacyObservation(
  input: LegacyCapabilityObservationInput,
): LegacyCapabilityObservation {
  const parsed = LegacyCapabilityObservationInput.parse(input);
  const core = {
    ...parsed,
    evidenceIds: [...new Set(parsed.evidenceIds)].sort(),
    claims: parsed.claims
      .map((claim) => ({
        ...claim,
        value: normalizeClaimValue(claim.value),
        evidenceIds: [...new Set(claim.evidenceIds)].sort(),
      }))
      .sort((left, right) => hashCanonical(left).localeCompare(hashCanonical(right))),
  };
  const result = addressed("lo", core);
  return LegacyCapabilityObservation.parse({
    ...core,
    observationId: result.id,
    recordHash: result.recordHash,
  });
}

export const LegacyCollectorDiagnostic = z
  .object({
    level: z.enum(["error", "warning", "info"]),
    code: z
      .string()
      .min(1)
      .max(128)
      .regex(/^legacy\/[a-z0-9][a-z0-9_/-]*$/),
    message: boundedText(2048),
    collectorId: LegacyIdentifier.optional(),
    coordinate: LegacyDeploymentCoordinate.optional(),
    artifactId: z
      .string()
      .regex(/^la_[0-9a-f]{64}$/)
      .optional(),
    evidenceId: z
      .string()
      .regex(/^le_[0-9a-f]{64}$/)
      .optional(),
    observationId: z
      .string()
      .regex(/^lo_[0-9a-f]{64}$/)
      .optional(),
    remediation: boundedText(2048).optional(),
  })
  .strict();
export type LegacyCollectorDiagnostic = z.infer<typeof LegacyCollectorDiagnostic>;

export const LegacyEstate = z
  .object({
    id: LegacyIdentifier,
    name: boundedText(256).optional(),
  })
  .strict();
export type LegacyEstate = z.infer<typeof LegacyEstate>;

export const LegacyInventoryDraft = z
  .object({
    schemaVersion: z.literal(1),
    estate: LegacyEstate,
    artifacts: z.array(LegacyArtifactRecord).max(LEGACY_MAX_RECORDS),
    evidence: z.array(LegacyEvidenceRecord).max(LEGACY_MAX_RECORDS),
    observations: z.array(LegacyCapabilityObservation).max(LEGACY_MAX_RECORDS),
    diagnostics: z.array(LegacyCollectorDiagnostic).max(LEGACY_MAX_RECORDS),
  })
  .strict()
  .superRefine((draft, ctx) => {
    const unique = (values: readonly string[], path: string, label: string) => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value)) {
          ctx.addIssue({
            code: "custom",
            path: [path, index],
            message: `duplicate ${label} '${value}'`,
          });
        }
        seen.add(value);
      });
    };
    unique(
      draft.artifacts.map((record) => record.artifactId),
      "artifacts",
      "artifactId",
    );
    unique(
      draft.evidence.map((record) => record.evidenceId),
      "evidence",
      "evidenceId",
    );
    unique(
      draft.observations.map((record) => record.observationId),
      "observations",
      "observationId",
    );

    const artifactById = new Map(draft.artifacts.map((record) => [record.artifactId, record]));
    draft.evidence.forEach((record, index) => {
      const artifact = artifactById.get(record.artifactId);
      if (!artifact) {
        ctx.addIssue({
          code: "custom",
          path: ["evidence", index, "artifactId"],
          message: "references an artifact outside this snapshot",
        });
      } else if (artifact.source.kind !== record.sourceKind) {
        ctx.addIssue({
          code: "custom",
          path: ["evidence", index, "sourceKind"],
          message: "must match the referenced artifact source kind",
        });
      }
    });
    const evidenceIds = new Set(draft.evidence.map((record) => record.evidenceId));
    draft.observations.forEach((record, observationIndex) => {
      record.evidenceIds.forEach((evidenceId, evidenceIndex) => {
        if (!evidenceIds.has(evidenceId)) {
          ctx.addIssue({
            code: "custom",
            path: ["observations", observationIndex, "evidenceIds", evidenceIndex],
            message: "references evidence outside this snapshot",
          });
        }
      });
    });
    const observationIds = new Set(draft.observations.map((record) => record.observationId));
    draft.diagnostics.forEach((diagnostic, index) => {
      if (diagnostic.artifactId && !artifactById.has(diagnostic.artifactId)) {
        ctx.addIssue({
          code: "custom",
          path: ["diagnostics", index, "artifactId"],
          message: "references an artifact outside this snapshot",
        });
      }
      if (diagnostic.evidenceId && !evidenceIds.has(diagnostic.evidenceId)) {
        ctx.addIssue({
          code: "custom",
          path: ["diagnostics", index, "evidenceId"],
          message: "references evidence outside this snapshot",
        });
      }
      if (diagnostic.observationId && !observationIds.has(diagnostic.observationId)) {
        ctx.addIssue({
          code: "custom",
          path: ["diagnostics", index, "observationId"],
          message: "references an observation outside this snapshot",
        });
      }
    });
  });
export type LegacyInventoryDraft = z.infer<typeof LegacyInventoryDraft>;

export const LegacyInventorySnapshot = z
  .object({
    schemaVersion: z.literal(1),
    inventoryId: z.string().regex(/^li_[0-9a-f]{64}$/),
    contentHash: LegacySha256,
    estate: LegacyEstate,
    artifacts: z.array(LegacyArtifactRecord).max(LEGACY_MAX_RECORDS),
    evidence: z.array(LegacyEvidenceRecord).max(LEGACY_MAX_RECORDS),
    observations: z.array(LegacyCapabilityObservation).max(LEGACY_MAX_RECORDS),
    diagnostics: z.array(LegacyCollectorDiagnostic).max(LEGACY_MAX_RECORDS),
  })
  .strict();
export type LegacyInventorySnapshot = z.infer<typeof LegacyInventorySnapshot>;

export const LegacyRankedEvidence = z
  .object({
    evidenceId: z.string().regex(/^le_[0-9a-f]{64}$/),
    sourceKind: EvidenceSourceKind,
    rank: z.number().int().min(100).max(900),
  })
  .strict();
export type LegacyRankedEvidence = z.infer<typeof LegacyRankedEvidence>;

export const LegacyClaimAssertion = z
  .object({
    value: LegacyClaimValue,
    bases: z.array(LegacyEvidenceBasis).min(1).max(LegacyEvidenceBasis.options.length),
    observationIds: z
      .array(z.string().regex(/^lo_[0-9a-f]{64}$/))
      .min(1)
      .max(LEGACY_MAX_REFERENCES),
    evidence: z.array(LegacyRankedEvidence).min(1).max(LEGACY_MAX_REFERENCES),
  })
  .strict();
export type LegacyClaimAssertion = z.infer<typeof LegacyClaimAssertion>;

export const LegacyCandidateClaim = z
  .object({
    dimension: LegacyClaimDimension,
    state: z.enum(["single", "conflicting"]),
    assertions: z.array(LegacyClaimAssertion).min(1).max(LEGACY_MAX_CLAIMS),
  })
  .strict();
export type LegacyCandidateClaim = z.infer<typeof LegacyCandidateClaim>;

export const LegacyClaimConflict = z
  .object({
    dimension: LegacyClaimDimension,
    values: z.array(LegacyClaimValue).min(2).max(LEGACY_MAX_CLAIMS),
    evidenceIds: z
      .array(z.string().regex(/^le_[0-9a-f]{64}$/))
      .min(1)
      .max(LEGACY_MAX_REFERENCES),
  })
  .strict();
export type LegacyClaimConflict = z.infer<typeof LegacyClaimConflict>;

export const LegacyCapabilityCandidate = z
  .object({
    schemaVersion: z.literal(1),
    candidateId: z.string().regex(/^lc_[0-9a-f]{64}$/),
    coordinate: LegacyDeploymentCoordinate,
    invocation: LegacyInvocation,
    observationIds: z
      .array(z.string().regex(/^lo_[0-9a-f]{64}$/))
      .min(1)
      .max(LEGACY_MAX_REFERENCES),
    evidenceIds: z
      .array(z.string().regex(/^le_[0-9a-f]{64}$/))
      .min(1)
      .max(LEGACY_MAX_REFERENCES),
    claims: z.array(LegacyCandidateClaim).max(LEGACY_MAX_CLAIMS),
    conflicts: z.array(LegacyClaimConflict).max(LEGACY_MAX_CLAIMS),
    businessSemantics: z.enum(["unknown", "asserted_unverified", "conflicting"]),
    disposition: z.enum(["triage", "review_required"]),
  })
  .strict();
export type LegacyCapabilityCandidate = z.infer<typeof LegacyCapabilityCandidate>;
