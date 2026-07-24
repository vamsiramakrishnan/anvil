/**
 * Durable gateway-import provenance.
 *
 * A receipt binds the exact gateway export container to the selected API,
 * normalized inventory, compiler source, policy overlays, diagnostics, and
 * generated output manifest. The private store preserves the original bytes;
 * generated bundles receive a path-redacted view with no embedded source
 * content or policy values.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { hashCanonical } from "@anvil/air";
import { z } from "zod";
import type { AnvilManifest } from "../manifest.js";
import { sha256Hex } from "../source/hash.js";
import { SourceDiagnostic, SourceEntrypoint, SourceFile } from "../source/model.js";
import { GatewayImportIdentity, verifyGatewayImportIdentity } from "./identity.js";
import {
  type EvidenceCoordinate,
  GATEWAY_MAX_ARTIFACT_EVIDENCE,
  GatewayArtifactEvidence,
  GatewayContractProvenance,
  GatewayDiagnostic,
  GatewayKind,
} from "./model.js";

const Sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const GatewayImportId = z.string().regex(/^gwi-[0-9a-f]{16}$/);

export const GatewayImportOverlayReceipt = z.object({
  role: z.enum(["gateway_policy", "import_guard"]),
  id: z.string(),
  digest: z.string(),
  evidence: z
    .array(
      z.object({
        id: z.string(),
        kind: z.string(),
        ref: z.string().optional(),
      }),
    )
    .default([]),
});
export type GatewayImportOverlayReceipt = z.infer<typeof GatewayImportOverlayReceipt>;

export const GatewayImportOutputFile = z.object({
  path: z
    .string()
    .min(1)
    .refine(
      (path) =>
        !path.startsWith("/") &&
        !path.includes("\\") &&
        !path.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
      "must be a safe relative POSIX path",
    ),
  sha256: Sha256Digest,
  bytes: z.number().int().nonnegative(),
});
export type GatewayImportOutputFile = z.infer<typeof GatewayImportOutputFile>;

export const GatewayCapabilityReviewDecision = z.object({
  capabilityId: z.string().min(1),
  state: z.enum(["approved", "rejected"]),
  allowLarge: z.boolean(),
  note: z.string().optional(),
});
export type GatewayCapabilityReviewDecision = z.infer<typeof GatewayCapabilityReviewDecision>;

export const GatewayCapabilityReviewInput = z.object({
  digest: Sha256Digest,
  decisions: z.array(GatewayCapabilityReviewDecision),
});
export type GatewayCapabilityReviewInput = z.infer<typeof GatewayCapabilityReviewInput>;

const GatewayCapabilityReviewView = z.object({
  digest: Sha256Digest,
  decisions: z.array(
    GatewayCapabilityReviewDecision.omit({ note: true }).extend({
      noteDigest: Sha256Digest.optional(),
    }),
  ),
});

/**
 * Receipt-bound relationship between a user-supplied contract and the native
 * WSO2 Definitions member(s) discovered for the selected API project.
 *
 * Exact byte equality is the default. An override is deliberately possible
 * only through an explicit operator attestation retained by the private
 * receipt; it is never inferred from route compatibility.
 */
export const GatewayFormalDefinitionLineage = z
  .object({
    mode: z.enum(["embedded_digest_match", "operator_override"]),
    candidates: z.array(GatewayArtifactEvidence).max(GATEWAY_MAX_ARTIFACT_EVIDENCE),
    supplied: z.object({
      path: z.string().min(1),
      digest: Sha256Digest,
    }),
    override: z
      .object({
        attestation: z.literal("operator"),
        reason: z.string().trim().min(1).max(2_000),
      })
      .optional(),
  })
  .superRefine((lineage, ctx) => {
    lineage.candidates.forEach((candidate, index) => {
      if (candidate.role !== "formal_definition") {
        ctx.addIssue({
          code: "custom",
          path: ["candidates", index, "role"],
          message: "formal-definition lineage candidates must have role formal_definition",
        });
      }
    });
    if (lineage.mode === "embedded_digest_match") {
      if (lineage.candidates.length !== 1) {
        ctx.addIssue({
          code: "custom",
          path: ["candidates"],
          message: "embedded digest match requires exactly one native definition candidate",
        });
      } else if (lineage.candidates[0]?.digest !== lineage.supplied.digest) {
        ctx.addIssue({
          code: "custom",
          path: ["supplied", "digest"],
          message: "supplied definition digest must match the native candidate digest",
        });
      }
      if (lineage.override !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["override"],
          message: "an exact embedded digest match cannot also claim an override",
        });
      }
    } else if (lineage.override === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["override"],
        message: "operator_override requires an explicit operator attestation and reason",
      });
    }
  });
export type GatewayFormalDefinitionLineage = z.infer<typeof GatewayFormalDefinitionLineage>;

const GatewayFormalDefinitionLineageView = z.object({
  mode: z.enum(["embedded_digest_match", "operator_override"]),
  candidates: z.array(GatewayArtifactEvidence).max(GATEWAY_MAX_ARTIFACT_EVIDENCE),
  supplied: z.object({
    path: z.string().min(1),
    digest: Sha256Digest,
  }),
  override: z
    .object({
      attestation: z.literal("operator"),
      reasonDigest: Sha256Digest,
    })
    .optional(),
});

export const GatewayImportReceipt = z.object({
  schemaVersion: z.literal(1),
  receiptType: z.literal("anvil.gateway-import"),
  importId: GatewayImportId,
  digest: Sha256Digest,
  selection: z.object({
    vendor: GatewayKind,
    apiId: z.string(),
    /**
     * Added to v1 receipts without making legacy v1 records unparsable. Every
     * new import writes it; absence identifies a legacy, non-coordinate-aware
     * lineage that must never be used to replace a new one.
     */
    identity: GatewayImportIdentity.optional(),
    export: z.object({
      format: z.enum(["text", "zip", "wso2_apictl_collection"]),
      sha256: Sha256Digest,
      bytes: z.number().int().nonnegative(),
      storedAs: z.literal("raw/export.bin"),
    }),
    archiveEntry: z.string().optional(),
    /** Exact selected native project/container members; optional on legacy receipts. */
    artifacts: z.array(GatewayArtifactEvidence).max(GATEWAY_MAX_ARTIFACT_EVIDENCE).optional(),
  }),
  inventory: z.object({
    digest: z.string(),
  }),
  contract: z.object({
    provenance: GatewayContractProvenance,
    compilerSource: z.object({
      snapshotId: z.string(),
      sourceHash: z.string(),
      entrypoint: z.string(),
    }),
    /** Present for WSO2 --spec imports that have native formal-definition evidence. */
    formalDefinitionLineage: GatewayFormalDefinitionLineage.optional(),
  }),
  /** Runtime coordinate is accepted only as an explicit operator attestation. */
  runtime: z
    .object({
      gatewayUrl: z.string().url(),
      attestation: z.literal("operator"),
    })
    .optional(),
  /** Stable, content-bearing projection of the SourceService lock (no clock or host path). */
  lockedSource: z
    .object({
      schemaVersion: z.literal(1),
      snapshotId: z.string(),
      sourceHash: z.string(),
      status: z.enum(["valid", "invalid", "unclassified"]),
      entrypoints: z.array(SourceEntrypoint),
      files: z.array(SourceFile),
      diagnostics: z.array(SourceDiagnostic),
    })
    .optional(),
  /** Canonical semantic compiler inputs that are not policy overlays. */
  compilerInput: z
    .object({
      manifestDigest: Sha256Digest.optional(),
      capabilityReviews: GatewayCapabilityReviewInput.optional(),
    })
    .optional(),
  overlays: z.array(GatewayImportOverlayReceipt),
  diagnostics: z.array(GatewayDiagnostic),
  blockers: z.array(GatewayDiagnostic),
  output: z.object({
    digest: Sha256Digest,
    files: z.array(GatewayImportOutputFile),
  }),
});
export type GatewayImportReceipt = z.infer<typeof GatewayImportReceipt>;
export type GatewayImportReceiptDraft = Omit<GatewayImportReceipt, "importId" | "digest">;

/**
 * Portable bundle pointer to the private receipt. This is intentionally not a
 * `GatewayImportReceipt`: redacting locators changes content, so presenting the
 * result with the full-receipt discriminant/digest fields would make a
 * non-verifiable document look verifiable.
 */
export const GatewayImportReceiptView = z.object({
  schemaVersion: z.literal(1),
  viewType: z.literal("anvil.gateway-import-receipt-view"),
  redacted: z.literal(true),
  importId: GatewayImportId,
  receiptDigest: Sha256Digest,
  lineage: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("bound"),
    }),
    z.object({
      status: z.literal("stale"),
      reason: z.string(),
      currentOutputDigest: Sha256Digest,
      currentOutputFiles: z.array(GatewayImportOutputFile),
    }),
  ]),
  privateReceipt: z.object({
    workspaceRoot: z.string(),
    storedAs: z.string(),
    verifyCommand: z.string(),
  }),
  selection: z.object({
    vendor: GatewayKind,
    apiId: z.string(),
    identity: GatewayImportIdentity.optional(),
    export: z.object({
      format: z.enum(["text", "zip", "wso2_apictl_collection"]),
      sha256: Sha256Digest,
      bytes: z.number().int().nonnegative(),
    }),
    archiveEntry: z.string().optional(),
    artifacts: z.array(GatewayArtifactEvidence).max(GATEWAY_MAX_ARTIFACT_EVIDENCE).optional(),
  }),
  inventoryDigest: z.string(),
  contract: z.object({
    provenance: GatewayContractProvenance,
    compilerSource: z.object({
      snapshotId: z.string(),
      sourceHash: z.string(),
      entrypoint: z.string(),
    }),
    formalDefinitionLineage: GatewayFormalDefinitionLineageView.optional(),
  }),
  runtime: z
    .object({
      gatewayUrl: z.string().url(),
      attestation: z.literal("operator"),
    })
    .optional(),
  lockedSource: z
    .object({
      snapshotId: z.string(),
      sourceHash: z.string(),
      entrypoints: z.array(SourceEntrypoint),
      files: z.array(SourceFile),
    })
    .optional(),
  compilerInput: z
    .object({
      manifestDigest: Sha256Digest.optional(),
      capabilityReviews: GatewayCapabilityReviewView.optional(),
    })
    .optional(),
  overlays: z.array(GatewayImportOverlayReceipt),
  diagnostics: z.array(GatewayDiagnostic),
  blockers: z.array(GatewayDiagnostic),
  output: z.object({
    digest: Sha256Digest,
    files: z.array(GatewayImportOutputFile),
  }),
});
export type GatewayImportReceiptView = z.infer<typeof GatewayImportReceiptView>;

const GATEWAY_LIFECYCLE_RECORDS: ReadonlySet<string> = new Set([
  "certification.json",
  "publication.json",
  "selftest.report.json",
  "conformance.report.json",
  "conformance.live.report.json",
  "simulation.report.json",
]);

/**
 * Artifacts created after import are outside the immutable import-output
 * manifest. They may coexist with a receipt-backed bundle, but never substitute
 * for or relax verification of a recorded file.
 */
export function isGatewayLifecycleArtifact(path: string): boolean {
  return (
    GATEWAY_LIFECYCLE_RECORDS.has(path) || (!path.includes("/") && path.endsWith(".report.json"))
  );
}

export interface GatewayReceiptDiagnostic {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  path?: string;
}

export interface GatewayReceiptVerification {
  ok: boolean;
  receipt?: GatewayImportReceipt;
  dir?: string;
  diagnostics: GatewayReceiptDiagnostic[];
}

export type CreateGatewayImportReceiptResult =
  | { ok: true; dir: string; created: boolean }
  | { ok: false; diagnostics: GatewayReceiptDiagnostic[] };

/** sha256 with the prefix used throughout provenance records. */
export function gatewaySha256(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

/**
 * Canonicalize parsed capability review input for immutable receipts. YAML
 * formatting, map order, manifest paths, and host coordinates never enter this
 * record; only the exact discovered id decision and its review semantics do.
 */
export function gatewayCapabilityReviewInput(
  reviews: AnvilManifest["capabilities"],
): GatewayCapabilityReviewInput | undefined {
  const decisions = Object.entries(reviews)
    .map(([capabilityId, review]) => ({
      capabilityId,
      state: review.state,
      allowLarge: review.allow_large === true,
      ...(review.note !== undefined ? { note: review.note } : {}),
    }))
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
  if (decisions.length === 0) return undefined;
  return GatewayCapabilityReviewInput.parse({
    digest: `sha256:${hashCanonical(decisions)}`,
    decisions,
  });
}

/** Canonical parsed-manifest identity; independent of YAML formatting and path. */
export function gatewayManifestDigest(manifest: AnvilManifest): string {
  return `sha256:${hashCanonical(manifest)}`;
}

/** Deterministic generated-output manifest. `import.receipt.json` must be excluded. */
export function gatewayBundleManifest(files: Record<string, string>): {
  digest: string;
  files: GatewayImportOutputFile[];
} {
  const encoder = new TextEncoder();
  const manifest = Object.entries(files)
    .filter(([path]) => path !== "import.receipt.json")
    .map(([path, contents]) => {
      const bytes = encoder.encode(contents);
      return { path, sha256: gatewaySha256(bytes), bytes: bytes.byteLength };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { digest: `sha256:${hashCanonical(manifest)}`, files: manifest };
}

/** Digest excludes the two fields it derives, making finalization repeatable. */
export function gatewayImportReceiptDigest(draft: GatewayImportReceiptDraft): string {
  return `sha256:${hashCanonical(draft)}`;
}

export function finalizeGatewayImportReceipt(
  draft: GatewayImportReceiptDraft,
): GatewayImportReceipt {
  const digest = gatewayImportReceiptDigest(draft);
  return GatewayImportReceipt.parse({
    ...draft,
    importId: `gwi-${digest.slice("sha256:".length, "sha256:".length + 16)}`,
    digest,
  });
}

/** Parse untrusted receipt JSON without throwing. */
export function parseGatewayImportReceipt(text: string): {
  receipt?: GatewayImportReceipt;
  diagnostics: GatewayReceiptDiagnostic[];
} {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      diagnostics: [
        {
          level: "error",
          code: "gateway_receipt/unparseable",
          message: `import.receipt.json is not valid JSON: ${(err as Error).message}`,
        },
      ],
    };
  }
  const parsed = GatewayImportReceipt.safeParse(raw);
  if (!parsed.success) {
    return {
      diagnostics: [
        {
          level: "error",
          code: "gateway_receipt/invalid",
          message: parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; "),
        },
      ],
    };
  }
  return { receipt: parsed.data, diagnostics: [] };
}

/**
 * Verify all content-addressed links inside a receipt. Supplying `exportBytes`
 * additionally proves the private raw container has not changed.
 */
export function verifyGatewayImportReceipt(
  receipt: GatewayImportReceipt,
  exportBytes?: Uint8Array,
): GatewayReceiptVerification {
  const diagnostics: GatewayReceiptDiagnostic[] = [];
  const { importId: _importId, digest: _digest, ...draft } = receipt;
  const digest = gatewayImportReceiptDigest(draft);
  const importId = `gwi-${digest.slice("sha256:".length, "sha256:".length + 16)}`;
  if (receipt.digest !== digest) {
    diagnostics.push({
      level: "error",
      code: "gateway_receipt/digest_mismatch",
      message: `Receipt digest ${receipt.digest} does not match recomputed ${digest}.`,
    });
  }
  if (receipt.importId !== importId) {
    diagnostics.push({
      level: "error",
      code: "gateway_receipt/id_mismatch",
      message: `Receipt id ${receipt.importId} does not match content-derived ${importId}.`,
    });
  }
  const identity = receipt.selection.identity;
  if (identity) {
    const identityVerification = verifyGatewayImportIdentity(identity);
    if (!identityVerification.ok) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/identity_digest_mismatch",
        message:
          `Gateway import identity digest ${identity.digest}/${identity.lineageDigest} does not match ` +
          `recomputed ${identityVerification.expectedDigest}/${identityVerification.expectedLineageDigest}.`,
      });
    }
    const mismatches = [
      identity.vendor !== receipt.selection.vendor ? "vendor" : undefined,
      identity.apiId !== receipt.selection.apiId ? "apiId" : undefined,
      identity.exportDigest !== receipt.selection.export.sha256 ? "exportDigest" : undefined,
      identity.inventoryDigest !== receipt.inventory.digest ? "inventoryDigest" : undefined,
    ].filter((value): value is string => value !== undefined);
    if (mismatches.length > 0) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/identity_coordinate_mismatch",
        message: `Gateway import identity disagrees with receipt field(s): ${mismatches.join(", ")}.`,
      });
    }
  }
  const canonicalOutputDigest = `sha256:${hashCanonical(receipt.output.files)}`;
  if (receipt.output.digest !== canonicalOutputDigest) {
    diagnostics.push({
      level: "error",
      code: "gateway_receipt/output_manifest_mismatch",
      message: `Output digest ${receipt.output.digest} does not match its file manifest ${canonicalOutputDigest}.`,
    });
  }
  const capabilityReviews = receipt.compilerInput?.capabilityReviews;
  if (capabilityReviews) {
    const canonicalDecisions = [...capabilityReviews.decisions].sort((left, right) =>
      left.capabilityId.localeCompare(right.capabilityId),
    );
    if (
      new Set(canonicalDecisions.map((decision) => decision.capabilityId)).size !==
        canonicalDecisions.length ||
      JSON.stringify(canonicalDecisions) !== JSON.stringify(capabilityReviews.decisions)
    ) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/capability_review_not_canonical",
        message: "Capability review decisions must have unique ids in ascending id order.",
      });
    }
    const canonicalReviewDigest = `sha256:${hashCanonical(canonicalDecisions)}`;
    if (capabilityReviews.digest !== canonicalReviewDigest) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/capability_review_digest_mismatch",
        message:
          `Capability review digest ${capabilityReviews.digest} does not match its canonical ` +
          `decision record ${canonicalReviewDigest}.`,
      });
    }
  }
  if (exportBytes) {
    const actualHash = gatewaySha256(exportBytes);
    if (actualHash !== receipt.selection.export.sha256) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/export_changed",
        message: `Export hash ${actualHash} does not match the recorded ${receipt.selection.export.sha256}.`,
        path: receipt.selection.export.storedAs,
      });
    }
    if (exportBytes.byteLength !== receipt.selection.export.bytes) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/export_size_changed",
        message: `Export size ${exportBytes.byteLength} does not match the recorded ${receipt.selection.export.bytes}.`,
        path: receipt.selection.export.storedAs,
      });
    }
  }
  const provenanceSource = receipt.contract.provenance.source;
  if (
    provenanceSource &&
    (provenanceSource.snapshotId !== receipt.contract.compilerSource.snapshotId ||
      provenanceSource.sourceHash !== receipt.contract.compilerSource.sourceHash ||
      provenanceSource.entrypoint !== receipt.contract.compilerSource.entrypoint)
  ) {
    diagnostics.push({
      level: "error",
      code: "gateway_receipt/contract_source_mismatch",
      message: "Contract provenance does not match the compiler source recorded by the receipt.",
    });
  }
  if (
    receipt.lockedSource &&
    (receipt.lockedSource.snapshotId !== receipt.contract.compilerSource.snapshotId ||
      receipt.lockedSource.sourceHash !== receipt.contract.compilerSource.sourceHash)
  ) {
    diagnostics.push({
      level: "error",
      code: "gateway_receipt/locked_source_mismatch",
      message: "Locked SourceService snapshot does not match the compiler source.",
    });
  }
  if (receipt.lockedSource) {
    const hash = createHash("sha256");
    for (const file of [...receipt.lockedSource.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    )) {
      hash.update(file.path);
      hash.update("\0");
      hash.update(file.sha256);
      hash.update("\0");
    }
    const sourceHash = `sha256:${hash.digest("hex")}`;
    if (sourceHash !== receipt.lockedSource.sourceHash) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/locked_source_manifest_mismatch",
        message: `Locked source file manifest hashes to ${sourceHash}, not ${receipt.lockedSource.sourceHash}.`,
      });
    }
    if (
      !receipt.lockedSource.entrypoints.some(
        (entrypoint) => entrypoint.path === receipt.contract.compilerSource.entrypoint,
      )
    ) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/locked_source_entrypoint_mismatch",
        message: "Compiler entrypoint is not present in the locked SourceService snapshot.",
      });
    }
  }
  const formalDefinitionLineage = receipt.contract.formalDefinitionLineage;
  if (formalDefinitionLineage) {
    if (receipt.selection.vendor !== "wso2") {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/formal_definition_vendor_mismatch",
        message: "Native formal-definition lineage is currently valid only for WSO2 imports.",
      });
    }
    const byCoordinate = (
      left: z.infer<typeof GatewayArtifactEvidence>,
      right: z.infer<typeof GatewayArtifactEvidence>,
    ): number =>
      left.origin.localeCompare(right.origin) ||
      left.path.localeCompare(right.path) ||
      left.digest.localeCompare(right.digest);
    const selectedCandidates = (receipt.selection.artifacts ?? [])
      .filter((artifact) => artifact.role === "formal_definition")
      .sort(byCoordinate);
    const recordedCandidates = [...formalDefinitionLineage.candidates].sort(byCoordinate);
    if (hashCanonical(selectedCandidates) !== hashCanonical(recordedCandidates)) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/formal_definition_candidates_mismatch",
        message:
          "Contract formal-definition candidates do not match the selected native artifact evidence.",
      });
    }
    const entrypointFile = receipt.lockedSource?.files.find(
      (file) => file.path === receipt.contract.compilerSource.entrypoint,
    );
    const lockedEntrypointDigest = entrypointFile
      ? `sha256:${entrypointFile.sha256.replace(/^sha256:/, "")}`
      : undefined;
    if (!lockedEntrypointDigest) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/formal_definition_source_missing",
        message:
          "Formal-definition lineage requires the supplied compiler entrypoint in the locked source manifest.",
      });
    } else if (lockedEntrypointDigest !== formalDefinitionLineage.supplied.digest) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/formal_definition_source_mismatch",
        message:
          `Locked compiler entrypoint digest ${lockedEntrypointDigest} does not match the ` +
          `formal-definition lineage digest ${formalDefinitionLineage.supplied.digest}.`,
      });
    }
  }
  return { ok: diagnostics.length === 0, receipt, diagnostics };
}

/** Verify the generated files recorded by a receipt against bytes on disk. */
export function verifyGatewayImportOutput(
  receipt: GatewayImportReceipt,
  files: ReadonlyMap<string, Uint8Array>,
): { ok: boolean; diagnostics: GatewayReceiptDiagnostic[] } {
  return verifyGatewayImportOutputManifest(receipt.output, files);
}

/** Verify an output manifest embedded in either a private receipt or its view. */
export function verifyGatewayImportOutputManifest(
  output: GatewayImportReceipt["output"],
  files: ReadonlyMap<string, Uint8Array>,
): { ok: boolean; diagnostics: GatewayReceiptDiagnostic[] } {
  const diagnostics: GatewayReceiptDiagnostic[] = [];
  const actualManifest: GatewayImportOutputFile[] = [];
  for (const expected of output.files) {
    const bytes = files.get(expected.path);
    if (!bytes) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/output_missing",
        message: "Generated file recorded by the import receipt is missing.",
        path: expected.path,
      });
      continue;
    }
    const actual = {
      path: expected.path,
      sha256: gatewaySha256(bytes),
      bytes: bytes.byteLength,
    };
    actualManifest.push(actual);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/output_changed",
        message: `Generated file no longer matches its recorded hash and size (${expected.sha256}, ${expected.bytes} bytes).`,
        path: expected.path,
      });
    }
  }
  if (actualManifest.length === output.files.length) {
    actualManifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const actualDigest = `sha256:${hashCanonical(actualManifest)}`;
    if (actualDigest !== output.digest) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/output_digest_mismatch",
        message: `Generated output digest ${actualDigest} does not match ${output.digest}.`,
      });
    }
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

/** Render a safe, explicitly non-authoritative bundle pointer to the private receipt. */
export function redactGatewayImportReceipt(
  receipt: GatewayImportReceipt,
  _options: { workspaceRoot?: string } = {},
): GatewayImportReceiptView {
  const workspaceRoot = "$WORKSPACE";
  return GatewayImportReceiptView.parse({
    schemaVersion: 1,
    viewType: "anvil.gateway-import-receipt-view",
    redacted: true,
    importId: receipt.importId,
    receiptDigest: receipt.digest,
    lineage: { status: "bound" },
    privateReceipt: {
      workspaceRoot,
      storedAs: `.anvil/imports/${receipt.importId}/import.receipt.json`,
      verifyCommand: `anvil estate verify ${receipt.importId} --root .`,
    },
    selection: {
      vendor: receipt.selection.vendor,
      apiId: receipt.selection.apiId,
      identity: receipt.selection.identity,
      export: {
        format: receipt.selection.export.format,
        sha256: receipt.selection.export.sha256,
        bytes: receipt.selection.export.bytes,
      },
      archiveEntry: receipt.selection.archiveEntry,
      artifacts: receipt.selection.artifacts?.map((artifact) => ({
        ...artifact,
        origin: redactOrigin(artifact.origin),
        parent: artifact.parent
          ? {
              ...artifact.parent,
              origin: redactOrigin(artifact.parent.origin),
            }
          : undefined,
      })),
    },
    inventoryDigest: receipt.inventory.digest,
    contract: {
      ...receipt.contract,
      provenance: {
        ...receipt.contract.provenance,
        location: redactCoordinate(receipt.contract.provenance.location),
      },
      formalDefinitionLineage: receipt.contract.formalDefinitionLineage
        ? {
            mode: receipt.contract.formalDefinitionLineage.mode,
            candidates: receipt.contract.formalDefinitionLineage.candidates.map((artifact) => ({
              ...artifact,
              origin: redactOrigin(artifact.origin),
              parent: artifact.parent
                ? {
                    ...artifact.parent,
                    origin: redactOrigin(artifact.parent.origin),
                  }
                : undefined,
            })),
            supplied: receipt.contract.formalDefinitionLineage.supplied,
            ...(receipt.contract.formalDefinitionLineage.override
              ? {
                  override: {
                    attestation: "operator" as const,
                    reasonDigest: gatewaySha256(
                      new TextEncoder().encode(
                        receipt.contract.formalDefinitionLineage.override.reason,
                      ),
                    ),
                  },
                }
              : {}),
          }
        : undefined,
    },
    runtime: receipt.runtime,
    lockedSource: receipt.lockedSource
      ? {
          snapshotId: receipt.lockedSource.snapshotId,
          sourceHash: receipt.lockedSource.sourceHash,
          entrypoints: receipt.lockedSource.entrypoints,
          files: receipt.lockedSource.files,
        }
      : undefined,
    compilerInput: receipt.compilerInput
      ? {
          manifestDigest: receipt.compilerInput.manifestDigest,
          capabilityReviews: receipt.compilerInput.capabilityReviews
            ? {
                digest: receipt.compilerInput.capabilityReviews.digest,
                decisions: receipt.compilerInput.capabilityReviews.decisions.map((decision) => ({
                  capabilityId: decision.capabilityId,
                  state: decision.state,
                  allowLarge: decision.allowLarge,
                  ...(decision.note !== undefined
                    ? {
                        noteDigest: gatewaySha256(new TextEncoder().encode(decision.note)),
                      }
                    : {}),
                })),
              }
            : undefined,
        }
      : undefined,
    overlays: receipt.overlays.map((overlay) => ({
      ...overlay,
      evidence: overlay.evidence.map((evidence) => ({
        ...evidence,
        ref: evidence.ref ? redactReference(evidence.ref) : undefined,
      })),
    })),
    diagnostics: receipt.diagnostics.map(redactDiagnostic),
    blockers: receipt.blockers.map(redactDiagnostic),
    output: receipt.output,
  });
}

function redactDiagnostic(diagnostic: GatewayDiagnostic): GatewayDiagnostic {
  return diagnostic.coordinate
    ? { ...diagnostic, coordinate: redactCoordinate(diagnostic.coordinate) }
    : diagnostic;
}

function redactCoordinate(
  coordinate: z.infer<typeof EvidenceCoordinate>,
): z.infer<typeof EvidenceCoordinate> {
  return { ...coordinate, origin: redactOrigin(coordinate.origin) };
}

function redactReference(ref: string): string {
  const hash = ref.indexOf("#");
  if (hash === -1) return redactOrigin(ref);
  return `${redactOrigin(ref.slice(0, hash))}${ref.slice(hash)}`;
}

function redactOrigin(origin: string): string {
  const bang = origin.indexOf("!");
  const host = bang === -1 ? origin : origin.slice(0, bang);
  const member = bang === -1 ? "" : origin.slice(bang);
  const normalized = host.replaceAll("\\", "/");
  const workspace = normalized.indexOf("/.anvil/");
  if (workspace >= 0) return `$WORKSPACE${normalized.slice(workspace)}${member}`;
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return `<gateway-export>/${basename(normalized)}${member}`;
  }
  return `${host}${member}`;
}

/**
 * Immutable receipt store:
 *
 *   <root>/<importId>/import.receipt.json
 *   <root>/<importId>/raw/export.bin
 */
export class FileSystemGatewayImportReceiptStore {
  constructor(private readonly root: string) {}

  async create(
    receipt: GatewayImportReceipt,
    exportBytes: Uint8Array,
  ): Promise<CreateGatewayImportReceiptResult> {
    const inputIntegrity = verifyGatewayImportReceipt(receipt, exportBytes);
    if (!inputIntegrity.ok) return { ok: false, diagnostics: inputIntegrity.diagnostics };

    const finalDir = join(this.root, receipt.importId);
    const existing = this.idempotentHit(receipt, finalDir);
    if (existing) return existing;

    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const tmp = join(this.root, `.tmp-${receipt.importId}-${randomBytes(4).toString("hex")}`);
    try {
      mkdirSync(join(tmp, "raw"), { recursive: true, mode: 0o700 });
      writeFileSync(join(tmp, "raw", "export.bin"), exportBytes, { mode: 0o600 });
      writeFileSync(join(tmp, "import.receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      try {
        renameSync(tmp, finalDir);
      } catch (err) {
        const raced = this.idempotentHit(receipt, finalDir);
        if (raced) return raced;
        throw err;
      }
      return { ok: true, dir: finalDir, created: true };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async load(importId: string): Promise<GatewayReceiptVerification> {
    if (!GatewayImportId.safeParse(importId).success) {
      return {
        ok: false,
        diagnostics: [
          {
            level: "error",
            code: "gateway_receipt/invalid_id",
            message: `'${importId}' is not a valid gateway import id.`,
          },
        ],
      };
    }
    const dir = join(this.root, importId);
    const path = join(dir, "import.receipt.json");
    if (!existsSync(path)) {
      return {
        ok: false,
        diagnostics: [
          {
            level: "error",
            code: "gateway_receipt/not_found",
            message: `No gateway import receipt '${importId}'.`,
          },
        ],
      };
    }
    const parsed = parseGatewayImportReceipt(readFileSync(path, "utf8"));
    return {
      ok: parsed.receipt !== undefined,
      receipt: parsed.receipt,
      dir,
      diagnostics: parsed.diagnostics,
    };
  }

  async verify(importId: string): Promise<GatewayReceiptVerification> {
    const loaded = await this.load(importId);
    if (!loaded.receipt || !loaded.dir) return loaded;
    const diagnostics = [...loaded.diagnostics];
    const rawPath = join(loaded.dir, "raw", "export.bin");
    const raw = existsSync(rawPath) ? readFileSync(rawPath) : undefined;
    if (!raw) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/export_missing",
        message: "The recorded original export is missing.",
        path: "raw/export.bin",
      });
    } else {
      diagnostics.push(...verifyGatewayImportReceipt(loaded.receipt, raw).diagnostics);
    }
    const expectedTop = new Set(["import.receipt.json", "raw"]);
    for (const entry of readdirSync(loaded.dir)) {
      if (!expectedTop.has(entry)) {
        diagnostics.push({
          level: "error",
          code: "gateway_receipt/unexpected_file",
          message: "Unexpected file in immutable import directory.",
          path: entry,
        });
      }
    }
    const rawDir = join(loaded.dir, "raw");
    if (existsSync(rawDir)) {
      for (const entry of readdirSync(rawDir)) {
        if (entry !== "export.bin") {
          diagnostics.push({
            level: "error",
            code: "gateway_receipt/unexpected_file",
            message: "Unexpected file in immutable import raw directory.",
            path: `raw/${entry}`,
          });
        }
      }
    }
    if (loaded.receipt.importId !== importId) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/directory_mismatch",
        message: `Directory '${importId}' contains receipt '${loaded.receipt.importId}'.`,
      });
    }
    return {
      ok: diagnostics.length === 0,
      receipt: loaded.receipt,
      dir: loaded.dir,
      diagnostics,
    };
  }

  private idempotentHit(
    receipt: GatewayImportReceipt,
    finalDir: string,
  ): CreateGatewayImportReceiptResult | undefined {
    if (!existsSync(finalDir)) return undefined;
    const path = join(finalDir, "import.receipt.json");
    const parsed = existsSync(path)
      ? parseGatewayImportReceipt(readFileSync(path, "utf8")).receipt
      : undefined;
    if (parsed?.digest === receipt.digest && parsed.importId === receipt.importId) {
      const rawPath = join(finalDir, "raw", "export.bin");
      const raw = existsSync(rawPath) ? readFileSync(rawPath) : undefined;
      const integrity = raw ? verifyGatewayImportReceipt(parsed, raw) : undefined;
      if (integrity?.ok && this.hasExpectedLayout(finalDir)) {
        return { ok: true, dir: finalDir, created: false };
      }
    }
    return {
      ok: false,
      diagnostics: [
        {
          level: "error",
          code: "gateway_receipt/id_collision",
          message: `Import slot '${receipt.importId}' exists but is not the same intact receipt; refusing to overwrite.`,
        },
      ],
    };
  }

  private hasExpectedLayout(dir: string): boolean {
    try {
      const top = readdirSync(dir).sort();
      const raw = readdirSync(join(dir, "raw")).sort();
      return (
        top.length === 2 &&
        top[0] === "import.receipt.json" &&
        top[1] === "raw" &&
        raw.length === 1 &&
        raw[0] === "export.bin"
      );
    } catch {
      return false;
    }
  }
}
