import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { airFromJson, airFromYaml } from "@anvil/air";
import { GatewayImportReceiptView, GatewayKind } from "@anvil/compiler";
import { certifyBundle, readBundleDir } from "@anvil/generators";
import type { Command } from "commander";
import { Option } from "commander";
import { parseDocument, stringify as stringifyYaml } from "yaml";
import {
  analyzeComposition,
  CompositionInputError,
  CompositionReviewManifest,
  type CompositionReviewManifest as CompositionReviewManifestType,
  type CompositionSourceProvenance,
  compositionEvidenceKey,
  type VerifiedCompositionEvidenceArtifact,
} from "../capability-composition.js";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

interface ComposeOptions {
  out: string;
  initReview?: string;
  review?: string;
  json?: boolean;
}

const MAX_REVIEW_EVIDENCE_BYTES = 1_048_576;

export function registerCapabilityCompose(parent: Command, ctx: CommandContext): void {
  const compose = annotate(
    parent
      .command("compose")
      .summary("Audit cross-source output overlap and initialize a bound review.")
      .description(
        "Deterministic and offline. Accepts two or more verified generated bundle directories without modifying them, then writes new audit/review artifacts outside those inputs. It extracts output data-point signatures and reports evidence candidates with auth and safety constraints intersected rather than weakened. Structural similarity never selects an authoritative source. `--init-review` writes an unresolved manifest; edit it with local digest-bound evidence and rerun using `--review`. The command never approves, builds, deploys, or generates a multi-source MCP server.",
      )
      .argument("<bundles...>", "two or more verified generated bundle directories")
      .requiredOption("--out <file>", "write the versioned composition audit JSON here")
      .addOption(
        new Option(
          "--init-review <file>",
          "write a new unresolved review-manifest scaffold; refuses an existing file",
        ).conflicts("review"),
      )
      .addOption(
        new Option(
          "--review <file>",
          "apply an edited, digest-bound review manifest on a deterministic rerun",
        ).conflicts("initReview"),
      )
      .option("--json", "also emit the complete audit report as JSON on stdout"),
    { mutates: true },
  );
  compose.action((bundles: string[], opts: ComposeOptions) => {
    ctx.code = runCapabilityCompose(bundles, opts, ctx.io);
  });
}

function compositionError(io: CliIO, json: boolean, code: string, message: string): number {
  if (json) {
    io.out(
      JSON.stringify(
        {
          schemaVersion: 1,
          reportType: "anvil.cross-source-composition-error",
          code,
          message,
        },
        null,
        2,
      ),
    );
  } else {
    io.err(`[${code}] ${message}`);
  }
  return 1;
}

function loadReview(path: string): CompositionReviewManifestType {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new CompositionInputError(
      "composition/review_unreadable",
      `Cannot read review manifest '${path}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const document = parseDocument(text, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new CompositionInputError(
      "composition/review_invalid_yaml",
      document.errors.map((error) => error.message).join("; "),
    );
  }
  const parsed = CompositionReviewManifest.safeParse(document.toJS());
  if (!parsed.success) {
    throw new CompositionInputError(
      "composition/review_invalid",
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; "),
    );
  }
  return parsed.data;
}

function verifyReviewEvidence(
  reviewPath: string,
  review: CompositionReviewManifestType,
): VerifiedCompositionEvidenceArtifact[] {
  const references = [
    ...review.candidates.flatMap((candidate) => candidate.relationEvidence),
    ...review.candidates.flatMap((candidate) => candidate.authorityEvidence),
  ];
  if (references.length === 0) return [];

  const reviewDir = dirname(realpathSync(reviewPath));
  const verified = new Map<string, VerifiedCompositionEvidenceArtifact>();
  for (const reference of references) {
    const candidatePath = resolve(reviewDir, reference.sourceRef);
    if (!within(reviewDir, candidatePath)) {
      throw new CompositionInputError(
        "composition/evidence_outside_review",
        `Evidence sourceRef '${reference.sourceRef}' escapes the review manifest directory.`,
      );
    }
    let resolvedEvidence: string;
    try {
      const direct = lstatSync(candidatePath);
      if (direct.isSymbolicLink()) {
        throw new CompositionInputError(
          "composition/evidence_symlink_refused",
          `Evidence sourceRef '${reference.sourceRef}' must be a regular local file, not a symbolic link.`,
        );
      }
      resolvedEvidence = realpathSync(candidatePath);
    } catch (error) {
      if (error instanceof CompositionInputError) throw error;
      throw new CompositionInputError(
        "composition/evidence_unreadable",
        `Cannot resolve evidence sourceRef '${reference.sourceRef}' relative to '${reviewPath}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!within(reviewDir, resolvedEvidence)) {
      throw new CompositionInputError(
        "composition/evidence_outside_review",
        `Evidence sourceRef '${reference.sourceRef}' resolves outside the review manifest directory.`,
      );
    }
    const metadata = statSync(resolvedEvidence);
    if (!metadata.isFile() || metadata.size === 0) {
      throw new CompositionInputError(
        "composition/evidence_not_regular_file",
        `Evidence sourceRef '${reference.sourceRef}' must resolve to a non-empty regular file.`,
      );
    }
    if (metadata.size > MAX_REVIEW_EVIDENCE_BYTES) {
      throw new CompositionInputError(
        "composition/evidence_too_large",
        `Evidence sourceRef '${reference.sourceRef}' is ${metadata.size} bytes; the offline review limit is ${MAX_REVIEW_EVIDENCE_BYTES}.`,
      );
    }
    const bytes = readFileSync(resolvedEvidence);
    if (bytes.byteLength !== metadata.size || bytes.byteLength > MAX_REVIEW_EVIDENCE_BYTES) {
      throw new CompositionInputError(
        "composition/evidence_changed_during_read",
        `Evidence sourceRef '${reference.sourceRef}' changed while it was being verified.`,
      );
    }
    const actualDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (actualDigest !== reference.artifactDigest) {
      throw new CompositionInputError(
        "composition/evidence_digest_mismatch",
        `Evidence sourceRef '${reference.sourceRef}' hashes to ${actualDigest}, not the review's ${reference.artifactDigest}.`,
      );
    }
    const artifact = {
      sourceRef: reference.sourceRef,
      artifactDigest: actualDigest,
      sizeBytes: bytes.byteLength,
      verification: "local_file_sha256" as const,
    };
    verified.set(compositionEvidenceKey(artifact), artifact);
  }
  return [...verified.values()].sort((left, right) =>
    compositionEvidenceKey(left).localeCompare(compositionEvidenceKey(right)),
  );
}

function assertNewOutput(path: string, label: string): void {
  if (existsSync(path)) {
    throw new CompositionInputError(
      "composition/output_exists",
      `${label} '${path}' already exists. Write a separate candidate artifact; Anvil will not overwrite review evidence.`,
    );
  }
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve symlinks in the nearest existing ancestor while preserving the
 * not-yet-created suffix. A lexical `resolve()` alone could let an output path
 * outside a bundle traverse a symlink back into compiler-owned bundle bytes.
 */
function canonicalNewOutputPath(path: string): string {
  const absolute = resolve(path);
  const suffix = [basename(absolute)];
  let ancestor = dirname(absolute);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

/**
 * Publish every output with an exclusive same-directory hard link. Unlike
 * rename, link cannot replace a target that appears after the preflight check.
 * The optional hook is a narrow deterministic seam for the TOCTOU regression
 * test; production callers never provide it.
 */
export function writeCompositionTransaction(
  outputs: Array<{ path: string; contents: string }>,
  hooks: { beforePublish?: () => void } = {},
): void {
  const staged: Array<{ temp: string; final: string }> = [];
  const published: Array<{ final: string; dev: number; ino: number }> = [];
  try {
    for (const output of outputs) {
      const final = resolve(output.path);
      mkdirSync(dirname(final), { recursive: true });
      const temp = resolve(
        dirname(final),
        `.${basename(final)}.anvil-compose-${process.pid}-${randomUUID()}.tmp`,
      );
      writeFileSync(temp, output.contents, { encoding: "utf8", flag: "wx" });
      staged.push({ temp, final });
    }
    hooks.beforePublish?.();
    for (const output of staged) {
      linkSync(output.temp, output.final);
      const identity = lstatSync(output.temp);
      published.push({
        final: output.final,
        dev: identity.dev,
        ino: identity.ino,
      });
    }
    for (const output of staged) unlinkSync(output.temp);
  } catch (error) {
    for (const output of published.reverse()) {
      if (!existsSync(output.final)) continue;
      const current = lstatSync(output.final);
      if (current.dev === output.dev && current.ino === output.ino) {
        unlinkSync(output.final);
      }
    }
    for (const output of staged) {
      if (existsSync(output.temp)) unlinkSync(output.temp);
    }
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      throw new CompositionInputError(
        "composition/output_exists",
        "A composition output appeared while publishing. No existing output was overwritten.",
      );
    }
    throw error;
  }
}

function loadBundleAir(dir: string, files: Record<string, string>): ReturnType<typeof airFromYaml> {
  if (files["air.yaml"] !== undefined) return airFromYaml(files["air.yaml"]);
  if (files["air.json"] !== undefined) return airFromJson(files["air.json"]);
  throw new CompositionInputError(
    "composition/air_missing",
    `No air.yaml or air.json in generated bundle '${dir}'.`,
  );
}

function loadCertifiedBundle(path: string): {
  dir: string;
  air: ReturnType<typeof loadBundleAir>;
  provenance: CompositionSourceProvenance;
} {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new CompositionInputError(
      "composition/bundle_directory_required",
      `Composition input '${path}' must be a generated bundle directory, not a bare AIR file.`,
    );
  }
  const dir = realpathSync(path);
  const files = readBundleDir(dir);
  const air = loadBundleAir(dir, files);
  const certification = certifyBundle(files, air);
  const generatedBytes = certification.checks.find(
    (check) => check.id === "contract.generated-bytes-agree",
  );
  if (generatedBytes?.status !== "passed") {
    throw new CompositionInputError(
      "composition/bundle_bytes_unverified",
      `Bundle '${path}' does not pass contract.generated-bytes-agree: ${generatedBytes?.detail ?? "check missing"}.`,
    );
  }

  const gateway = GatewayKind.safeParse(air.service.source.origin?.kind);
  if (!gateway.success) {
    return {
      dir,
      air,
      provenance: { kind: "plain_air", trust: "verified_generated_bundle" },
    };
  }

  const lineageCheck = certification.checks.find(
    (check) => check.id === "contract.gateway-lineage-current",
  );
  const receiptText = files["import.receipt.json"];
  if (receiptText === undefined) {
    return {
      dir,
      air,
      provenance: {
        kind: "gateway_receipt",
        trust: "missing",
        failureReasons: [lineageCheck?.detail ?? "Gateway-origin AIR has no import.receipt.json."],
        blockerCount: 0,
      },
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(receiptText);
  } catch (error) {
    return {
      dir,
      air,
      provenance: {
        kind: "gateway_receipt",
        trust: "invalid",
        failureReasons: [
          `import.receipt.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ],
        blockerCount: 0,
      },
    };
  }
  const parsed = GatewayImportReceiptView.safeParse(raw);
  if (!parsed.success) {
    return {
      dir,
      air,
      provenance: {
        kind: "gateway_receipt",
        trust: "invalid",
        failureReasons: parsed.error.issues.map(
          (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
        ),
        blockerCount: 0,
      },
    };
  }
  const receipt = parsed.data;
  const failureReasons =
    lineageCheck?.status === "passed"
      ? []
      : [lineageCheck?.detail ?? "contract.gateway-lineage-current check is missing"];
  if (!receipt.selection.identity) {
    failureReasons.push("Gateway receipt is legacy or incomplete: selection.identity is missing.");
  }
  const trust =
    receipt.lineage.status === "stale"
      ? "stale"
      : failureReasons.length === 0
        ? "verified"
        : "invalid";
  return {
    dir,
    air,
    provenance: {
      kind: "gateway_receipt",
      trust,
      receiptDigest: receipt.receiptDigest,
      importId: receipt.importId,
      ...(receipt.selection.identity ? { identity: receipt.selection.identity } : {}),
      failureReasons:
        receipt.lineage.status === "stale"
          ? [receipt.lineage.reason, ...failureReasons]
          : failureReasons,
      blockerCount: receipt.blockers.length,
    },
  };
}

function runCapabilityCompose(bundlePaths: string[], opts: ComposeOptions, io: CliIO): number {
  try {
    if (bundlePaths.length < 2) {
      throw new CompositionInputError(
        "composition/two_sources_required",
        "Provide at least two verified generated bundle directories.",
      );
    }
    if (!opts.initReview && !opts.review) {
      throw new CompositionInputError(
        "composition/review_mode_required",
        "Initialize a review with --init-review <file>, or rerun with --review <edited-file>.",
      );
    }
    const auditOutput = canonicalNewOutputPath(opts.out);
    const reviewArtifact = canonicalNewOutputPath(opts.initReview ?? opts.review ?? "");
    if (auditOutput === reviewArtifact) {
      throw new CompositionInputError(
        "composition/output_collision",
        "The audit output and review manifest must be different files.",
      );
    }
    const bundles = bundlePaths.map((path) => {
      try {
        return loadCertifiedBundle(path);
      } catch (error) {
        if (error instanceof CompositionInputError) throw error;
        throw new CompositionInputError(
          "composition/air_unreadable",
          `Cannot load and verify AIR bundle '${path}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    const initReviewOutput = opts.initReview ? canonicalNewOutputPath(opts.initReview) : undefined;
    const outputPaths = [auditOutput, ...(initReviewOutput ? [initReviewOutput] : [])];
    for (const outputPath of outputPaths) {
      const owningBundle = bundles.find((bundle) => within(bundle.dir, outputPath));
      if (owningBundle) {
        throw new CompositionInputError(
          "composition/output_inside_bundle",
          `Output '${outputPath}' is inside input bundle '${owningBundle.dir}'. Composition evidence must not contaminate compiler-owned bundle bytes.`,
        );
      }
    }
    assertNewOutput(auditOutput, "Audit output");
    if (initReviewOutput) {
      assertNewOutput(initReviewOutput, "Review scaffold");
    }

    const inputs = bundles.map(({ air, provenance }) => ({ air, provenance }));
    const review = opts.review ? loadReview(opts.review) : undefined;
    const verifiedEvidence = opts.review && review ? verifyReviewEvidence(opts.review, review) : [];
    const { report, scaffold } = analyzeComposition(inputs, review, verifiedEvidence);

    const outputs = [
      {
        path: auditOutput,
        contents: `${JSON.stringify(report, null, 2)}\n`,
      },
    ];
    if (initReviewOutput) {
      const guidance = [
        "# Anvil cross-source composition review",
        "# Structural matches are investigation candidates, never source authority.",
        "# Review semantic relation separately from scoped read authority.",
        "# Evidence must target exact memberIds. sourceRef is a normalized local file",
        "# path relative to this manifest and artifactDigest is its required SHA-256.",
        "# File/digest verification proves integrity, not the truth of its claim.",
        "# Read authority requires cited",
        "# system_of_record=true, lineage, and freshness=current evidence.",
        "# Each necessary factor needs effective confidence >= 0.5 (declared",
        "# confidence times canonical source-kind reliability); score is display-only.",
        "# review_required findings may be acknowledged; blocked findings must be",
        "# resolved upstream and can never be waived by a note or confidence score.",
        "# Write authority and multi-source MCP generation are outside this slice.",
        "",
      ].join("\n");
      outputs.push({
        path: initReviewOutput,
        contents: `${guidance}${stringifyYaml(scaffold, { lineWidth: 0 })}`,
      });
    }
    writeCompositionTransaction(outputs);

    if (opts.json) {
      io.out(JSON.stringify(report, null, 2));
    } else {
      io.out(
        `Composition audit: ${report.summary.sourceCount} sources, ${report.summary.operationCount} operations, ${report.summary.candidateCount} candidate(s).`,
      );
      io.out(
        `  dispositions: ${report.summary.dispositions.unresolved} unresolved, ${report.summary.dispositions.candidate} candidate, ${report.summary.dispositions.reviewed} reviewed`,
      );
      io.out(`  report: ${opts.out}`);
      io.out(`  reportHash: ${report.reportHash}`);
      if (opts.initReview) io.out(`  review scaffold: ${opts.initReview}`);
      if (opts.review) {
        io.out(`  applied review: ${opts.review}`);
        io.out(`  reviewed plans: ${report.summary.reviewedPlanCount}`);
      }
      io.out(
        "  boundary: audit/review plan only; no authority inference, MCP generation, approval, build, or deploy.",
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof CompositionInputError) {
      return compositionError(io, opts.json === true, error.code, error.message);
    }
    return compositionError(
      io,
      opts.json === true,
      "composition/unexpected_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}
