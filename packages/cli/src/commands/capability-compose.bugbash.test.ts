import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AirDocument, loadAirDocument } from "@anvil/air";
import { generateBundle, writeBundle } from "@anvil/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { runAnvilCli } from "../anvil-cli.js";
import type { CompositionAuditReport } from "../capability-composition.js";
import { bufferIO } from "../io.js";

/**
 * Targeted coverage for packages/cli/src/commands/capability-compose.ts.
 * Nothing besides `registerCapabilityCompose` and `writeCompositionTransaction`
 * is exported from that module (already exercised elsewhere), so every
 * scenario here drives the real `anvil capability compose` command end to
 * end through runAnvilCli, focused on branches the sibling
 * src/capability-compose.test.ts does not already reach: input validation,
 * bundle-loading failure modes, gateway receipt trust states, review-manifest
 * loading errors, local evidence-file verification failures, output
 * collision/containment/existence guards, and the unexpected-error fallback.
 *
 * Fixtures are built directly from `loadAirDocument` (skipping the OpenAPI
 * `compile()` round-trip) the same way
 * src/capability-composition.bugbash.test.ts does, since only structural
 * validity matters for these command-level branches.
 */

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-capability-compose-cmd-bugbash-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function rawOperation(input: {
  id: string;
  auth?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: input.id,
    canonicalName: input.id,
    displayName: input.id,
    sourceRef: { kind: "openapi" },
    effect: { kind: "read" },
    input: { params: [] },
    output: {},
    idempotency: { mode: "natural" },
    retries: { mode: "safe" },
    confirmation: { required: false },
    auth: {
      type: "none",
      scopes: [],
      principal: "anonymous",
      secretSource: "none",
      ...input.auth,
    },
    cli: { command: input.id },
    mcp: { toolName: input.id },
    skill: {},
    state: "approved",
  };
}

function rawAir(input: { serviceId: string; service?: Record<string, unknown> }): AirDocument {
  return loadAirDocument({
    service: {
      id: input.serviceId,
      version: "1.0.0",
      source: { kind: "openapi" },
      ...input.service,
    },
    operations: [rawOperation({ id: `get${input.serviceId.replace(/[^a-zA-Z0-9]/g, "")}` })],
  });
}

/** A minimal, otherwise-valid generated bundle directory (plain_air provenance). */
function buildBundle(dir: string, serviceId: string): string {
  writeBundle(dir, generateBundle(rawAir({ serviceId })));
  return dir;
}

/** A generated bundle whose AIR records a gateway origin, with a caller-controlled receipt. */
function buildGatewayBundle(dir: string, serviceId: string, receiptText?: string): string {
  const air = rawAir({
    serviceId,
    service: {
      source: {
        kind: "openapi",
        origin: { kind: "fixture", uri: `fixture://${serviceId}` },
      },
    },
  });
  const bundle = generateBundle(air);
  if (receiptText !== undefined) bundle.files["import.receipt.json"] = receiptText;
  writeBundle(dir, bundle);
  return dir;
}

function validGatewayReceiptJsonWithoutIdentity(): string {
  const digest = `sha256:${"a".repeat(64)}`;
  const receipt = {
    schemaVersion: 1,
    viewType: "anvil.gateway-import-receipt-view",
    redacted: true,
    importId: "gwi-0123456789abcdef",
    receiptDigest: digest,
    lineage: { status: "bound" },
    privateReceipt: {
      workspaceRoot: "$WORKSPACE",
      storedAs: ".anvil/imports/fixture/import.receipt.json",
      verifyCommand: "anvil estate verify fixture --root .",
    },
    selection: {
      vendor: "fixture",
      apiId: "gw-legacy",
      export: { format: "text", sha256: digest, bytes: 10 },
    },
    inventoryDigest: "inventory-digest",
    contract: {
      provenance: {
        kind: "native",
        fidelity: "full",
        format: "openapi",
        location: { origin: "fixture-export.yaml" },
      },
      compilerSource: { snapshotId: "src-1", sourceHash: digest, entrypoint: "openapi.yaml" },
    },
    overlays: [],
    diagnostics: [],
    blockers: [],
    output: { digest, files: [] },
  };
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

async function compose(
  bundles: string[],
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const io = bufferIO();
  const code = await runAnvilCli(["capability", "compose", ...bundles, ...args], { io });
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

function report(path: string): CompositionAuditReport {
  return JSON.parse(readFileSync(path, "utf8")) as CompositionAuditReport;
}

function errorJson(out: string): { code: string; message: string } {
  return JSON.parse(out) as { code: string; message: string };
}

/** A minimal, schema-valid review manifest with one evidence reference the caller controls. */
function reviewManifestWithEvidence(sourceRef: string): unknown {
  const digest = `sha256:${"b".repeat(64)}`;
  return {
    schemaVersion: 1,
    reportType: "anvil.cross-source-composition-review",
    inputDigest: digest,
    candidateDigest: digest,
    candidates: [
      {
        candidateId: "cand-1",
        candidateDigest: digest,
        eligibleSources: ["source-a", "source-b"],
        eligibleMembers: ["member-a", "member-b"],
        semanticRelation: "pending",
        relationEvidence: [
          {
            memberIds: ["member-a", "member-b"],
            sourceKind: "source_impl",
            sourceRef,
            artifactDigest: digest,
            confidence: 0.9,
          },
        ],
        readAuthority: { decision: "pending" },
        authorityEvidence: [],
        acknowledgedContradictions: [],
      },
    ],
  };
}

describe("anvil capability compose — input validation", () => {
  it("requires at least two bundle directories", async () => {
    const result = await compose(
      [join(work, "only-one")],
      ["--out", join(work, "out.json"), "--init-review", join(work, "review.yaml"), "--json"],
    );
    expect(result.code).toBe(1);
    expect(errorJson(result.out)).toMatchObject({ code: "composition/two_sources_required" });
  });

  it("requires --init-review or --review to be set", async () => {
    const result = await compose(
      [join(work, "a"), join(work, "b")],
      ["--out", join(work, "out.json"), "--json"],
    );
    expect(result.code).toBe(1);
    expect(errorJson(result.out)).toMatchObject({ code: "composition/review_mode_required" });
  });

  it("rejects --init-review and --review passed together (commander conflicts)", async () => {
    const result = await compose(
      [join(work, "a"), join(work, "b")],
      [
        "--out",
        join(work, "out.json"),
        "--init-review",
        join(work, "scaffold.yaml"),
        "--review",
        join(work, "scaffold.yaml"),
      ],
    );
    expect(result.code).toBe(1);
    expect(result.err.length).toBeGreaterThan(0);
  });

  it("rejects an --out and --init-review that resolve to the same file", async () => {
    const same = join(work, "same.json");
    const result = await compose(
      [join(work, "a"), join(work, "b")],
      ["--out", same, "--init-review", same, "--json"],
    );
    expect(result.code).toBe(1);
    expect(errorJson(result.out)).toMatchObject({ code: "composition/output_collision" });
  });

  it("rejects an --out and --review that resolve to the same file", async () => {
    const same = join(work, "same-review.yaml");
    const result = await compose(
      [join(work, "a"), join(work, "b")],
      ["--out", same, "--review", same, "--json"],
    );
    expect(result.code).toBe(1);
    expect(errorJson(result.out)).toMatchObject({ code: "composition/output_collision" });
  });

  it("emits a `[code] message` line on stderr for a non-JSON error", async () => {
    const result = await compose([join(work, "only-one")], ["--out", join(work, "out.json")]);
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toMatch(/^\[composition\/two_sources_required\] /);
  });
});

describe("anvil capability compose — bundle loading failures", () => {
  it("rejects a bundle path that does not exist and one that is a regular file", async () => {
    const valid = buildBundle(join(work, "valid"), "valid-source");

    const missing = await compose(
      [join(work, "does-not-exist"), valid],
      ["--out", join(work, "out1.json"), "--init-review", join(work, "review1.yaml"), "--json"],
    );
    expect(missing.code).toBe(1);
    expect(errorJson(missing.out)).toMatchObject({
      code: "composition/bundle_directory_required",
    });

    const notADir = join(work, "not-a-dir.txt");
    writeFileSync(notADir, "not a bundle\n");
    const fileArg = await compose(
      [notADir, valid],
      ["--out", join(work, "out2.json"), "--init-review", join(work, "review2.yaml"), "--json"],
    );
    expect(fileArg.code).toBe(1);
    expect(errorJson(fileArg.out)).toMatchObject({
      code: "composition/bundle_directory_required",
    });
  });

  it("rejects a bundle directory with no air.yaml or air.json", async () => {
    const empty = join(work, "empty-bundle");
    mkdirSync(empty, { recursive: true });
    const valid = buildBundle(join(work, "valid"), "valid-source");

    const result = await compose(
      [empty, valid],
      ["--out", join(work, "out.json"), "--init-review", join(work, "review.yaml"), "--json"],
    );
    expect(result.code).toBe(1);
    expect(errorJson(result.out)).toMatchObject({ code: "composition/air_missing" });
    expect(errorJson(result.out).message).toContain(empty);
  });

  it("rejects a bundle whose generated bytes were tampered with after generation", async () => {
    const tampered = buildBundle(join(work, "tampered"), "tampered-source");
    writeFileSync(join(tampered, "catalog.json"), '{"tampered":true}\n');
    const valid = buildBundle(join(work, "valid"), "valid-source");

    const result = await compose(
      [tampered, valid],
      ["--out", join(work, "out.json"), "--init-review", join(work, "review.yaml"), "--json"],
    );
    expect(result.code).toBe(1);
    expect(errorJson(result.out)).toMatchObject({ code: "composition/bundle_bytes_unverified" });
  });

  it("wraps a non-composition bundle-loading failure as air_unreadable", async () => {
    // A symlink inside a bundle makes readBundleDir throw a plain Error
    // (not a CompositionInputError); the command must still translate it
    // into a structured composition/* error rather than leaking it raw.
    const sneaky = buildBundle(join(work, "sneaky"), "sneaky-source");
    const externalTarget = join(work, "external-target.txt");
    writeFileSync(externalTarget, "outside content\n");
    symlinkSync(externalTarget, join(sneaky, "sneaky-link"));
    const valid = buildBundle(join(work, "valid"), "valid-source");

    const result = await compose(
      [sneaky, valid],
      ["--out", join(work, "out.json"), "--init-review", join(work, "review.yaml"), "--json"],
    );
    expect(result.code).toBe(1);
    expect(errorJson(result.out)).toMatchObject({ code: "composition/air_unreadable" });
  });
});

describe("anvil capability compose — output guards", () => {
  it("refuses to overwrite an existing --out target", async () => {
    const a = buildBundle(join(work, "a"), "source-a");
    const b = buildBundle(join(work, "b"), "source-b");
    const out = join(work, "preexisting-out.json");
    writeFileSync(out, "already here\n");

    const result = await compose(
      [a, b],
      ["--out", out, "--init-review", join(work, "review.yaml"), "--json"],
    );
    expect(result.code).toBe(1);
    expect(errorJson(result.out)).toMatchObject({ code: "composition/output_exists" });
    expect(errorJson(result.out).message).toContain("Audit output");
    expect(readFileSync(out, "utf8")).toBe("already here\n");
  });

  it("refuses to overwrite an existing --init-review scaffold target", async () => {
    const a = buildBundle(join(work, "a"), "source-a");
    const b = buildBundle(join(work, "b"), "source-b");
    const scaffold = join(work, "preexisting-scaffold.yaml");
    writeFileSync(scaffold, "already here\n");

    const result = await compose(
      [a, b],
      ["--out", join(work, "out.json"), "--init-review", scaffold, "--json"],
    );
    expect(result.code).toBe(1);
    expect(errorJson(result.out)).toMatchObject({ code: "composition/output_exists" });
    expect(errorJson(result.out).message).toContain("Review scaffold");
    expect(readFileSync(scaffold, "utf8")).toBe("already here\n");
  });

  it("refuses an --init-review path nested directly inside an input bundle directory", async () => {
    const a = buildBundle(join(work, "a"), "source-a");
    const b = buildBundle(join(work, "b"), "source-b");
    const nestedReview = join(a, "nested", "review.yaml");

    const result = await compose(
      [a, b],
      ["--out", join(work, "out.json"), "--init-review", nestedReview, "--json"],
    );
    expect(result.code).toBe(1);
    expect(errorJson(result.out)).toMatchObject({ code: "composition/output_inside_bundle" });
    expect(existsSync(nestedReview)).toBe(false);
  });

  it("creates missing parent directories for a new nested --out path", async () => {
    const a = buildBundle(join(work, "a"), "source-a");
    const b = buildBundle(join(work, "b"), "source-b");
    const nestedOut = join(work, "nested", "deep", "out.json");
    const nestedScaffold = join(work, "nested", "deep", "review.yaml");

    const result = await compose(
      [a, b],
      ["--out", nestedOut, "--init-review", nestedScaffold, "--json"],
    );
    expect(result.code, result.err || result.out).toBe(0);
    expect(existsSync(nestedOut)).toBe(true);
    expect(existsSync(nestedScaffold)).toBe(true);
  });

  it("surfaces unexpected_error for a non-EEXIST failure while publishing", async () => {
    const a = buildBundle(join(work, "a"), "source-a");
    const b = buildBundle(join(work, "b"), "source-b");
    // A regular file standing in for a directory component of --out makes
    // mkdirSync(..., { recursive: true }) inside writeCompositionTransaction
    // fail. Using the file itself as the parent directory yields EEXIST
    // (handled specially, becomes composition/output_exists), so the path
    // must sit two levels below the blocker file: mkdir then has to create
    // an intermediate directory *inside* the file, which fails with ENOTDIR
    // — a plain fs error, not a CompositionInputError — exercising the outer
    // catch-all fallback in runCapabilityCompose.
    const blocker = join(work, "blocker-file.txt");
    writeFileSync(blocker, "i am a file, not a directory\n");
    const out = join(blocker, "sub", "out.json");

    const result = await compose(
      [a, b],
      ["--out", out, "--init-review", join(work, "review.yaml"), "--json"],
    );
    expect(result.code).toBe(1);
    expect(errorJson(result.out)).toMatchObject({ code: "composition/unexpected_error" });
    expect(existsSync(out)).toBe(false);
  });
});

describe("anvil capability compose — gateway receipt provenance", () => {
  it("marks a gateway-origin bundle with no import.receipt.json as trust=missing", async () => {
    const gw = buildGatewayBundle(join(work, "gw-missing"), "gw-missing", undefined);
    const other = buildBundle(join(work, "other"), "other-source");
    const out = join(work, "out.json");

    const result = await compose(
      [gw, other],
      ["--out", out, "--init-review", join(work, "review.yaml")],
    );
    expect(result.code, result.err).toBe(0);
    const source = report(out).sources.find((entry) => entry.provenance.kind === "gateway_receipt");
    expect(source?.provenance).toMatchObject({ kind: "gateway_receipt", trust: "missing" });
  });

  it("marks a gateway-origin bundle with unparsable JSON receipt as trust=invalid", async () => {
    const gw = buildGatewayBundle(join(work, "gw-badjson"), "gw-badjson", "not json{");
    const other = buildBundle(join(work, "other"), "other-source");
    const out = join(work, "out.json");

    const result = await compose(
      [gw, other],
      ["--out", out, "--init-review", join(work, "review.yaml")],
    );
    expect(result.code, result.err).toBe(0);
    const source = report(out).sources.find((entry) => entry.provenance.kind === "gateway_receipt");
    expect(source?.provenance).toMatchObject({ kind: "gateway_receipt", trust: "invalid" });
    const failureReasons =
      source?.provenance.kind === "gateway_receipt"
        ? source.provenance.failureReasons.join("\n")
        : "";
    expect(failureReasons).toContain("not valid JSON");
  });

  it("marks a gateway-origin bundle with a schema-invalid receipt as trust=invalid", async () => {
    const gw = buildGatewayBundle(join(work, "gw-badschema"), "gw-badschema", "{}\n");
    const other = buildBundle(join(work, "other"), "other-source");
    const out = join(work, "out.json");

    const result = await compose(
      [gw, other],
      ["--out", out, "--init-review", join(work, "review.yaml")],
    );
    expect(result.code, result.err).toBe(0);
    const source = report(out).sources.find((entry) => entry.provenance.kind === "gateway_receipt");
    expect(source?.provenance).toMatchObject({ kind: "gateway_receipt", trust: "invalid" });
  });

  it("marks a schema-valid but identity-less gateway receipt as trust=invalid", async () => {
    const gw = buildGatewayBundle(
      join(work, "gw-legacy"),
      "gw-legacy",
      validGatewayReceiptJsonWithoutIdentity(),
    );
    const other = buildBundle(join(work, "other"), "other-source");
    const out = join(work, "out.json");

    const result = await compose(
      [gw, other],
      ["--out", out, "--init-review", join(work, "review.yaml")],
    );
    expect(result.code, result.err).toBe(0);
    const source = report(out).sources.find((entry) => entry.provenance.kind === "gateway_receipt");
    expect(source?.provenance).toMatchObject({ kind: "gateway_receipt", trust: "invalid" });
    const failureReasons =
      source?.provenance.kind === "gateway_receipt"
        ? source.provenance.failureReasons.join("\n")
        : "";
    expect(failureReasons).toContain("selection.identity is missing");
  });
});

describe("anvil capability compose — review manifest loading", () => {
  it("rejects a --review path that does not exist", async () => {
    const a = buildBundle(join(work, "a"), "source-a");
    const b = buildBundle(join(work, "b"), "source-b");

    const result = await compose(
      [a, b],
      ["--out", join(work, "out.json"), "--review", join(work, "does-not-exist.yaml"), "--json"],
    );
    expect(result.code).toBe(1);
    expect(errorJson(result.out)).toMatchObject({ code: "composition/review_unreadable" });
  });

  it("rejects a --review file with malformed YAML syntax", async () => {
    const a = buildBundle(join(work, "a"), "source-a");
    const b = buildBundle(join(work, "b"), "source-b");
    const badYaml = join(work, "bad.yaml");
    writeFileSync(badYaml, "candidates: [1, 2\n");

    const result = await compose(
      [a, b],
      ["--out", join(work, "out.json"), "--review", badYaml, "--json"],
    );
    expect(result.code).toBe(1);
    expect(errorJson(result.out)).toMatchObject({ code: "composition/review_invalid_yaml" });
  });

  it("round-trips an unedited scaffold back through --review on the same bundles", async () => {
    const a = buildBundle(join(work, "a"), "source-a");
    const b = buildBundle(join(work, "b"), "source-b");
    const scaffoldOut = join(work, "first.json");
    const scaffold = join(work, "scaffold.yaml");
    expect((await compose([a, b], ["--out", scaffoldOut, "--init-review", scaffold])).code).toBe(0);

    const rerunOut = join(work, "second.json");
    const rerun = await compose([a, b], ["--out", rerunOut, "--review", scaffold]);
    expect(rerun.code, rerun.err).toBe(0);
    expect(rerun.out).toContain(`applied review: ${scaffold}`);
    expect(rerun.out).toContain("reviewed plans: 0");
    expect(report(rerunOut).summary.reviewedPlanCount).toBe(0);
  });
});

describe("anvil capability compose — local evidence-file verification", () => {
  it("refuses evidence sourceRef that is itself a symlink", async () => {
    const a = buildBundle(join(work, "a"), "source-a");
    const b = buildBundle(join(work, "b"), "source-b");
    const target = join(work, "target.json");
    writeFileSync(target, '{"real":true}\n');
    symlinkSync(target, join(work, "evidence-link.json"));
    const reviewPath = join(work, "review.yaml");
    writeFileSync(
      reviewPath,
      stringifyYaml(reviewManifestWithEvidence("evidence-link.json"), { lineWidth: 0 }),
    );

    const result = await compose(
      [a, b],
      ["--out", join(work, "out.json"), "--review", reviewPath, "--json"],
    );
    expect(result.code).toBe(1);
    expect(errorJson(result.out)).toMatchObject({ code: "composition/evidence_symlink_refused" });
  });

  it("refuses evidence reached outside the review directory via a symlinked dir", async () => {
    const a = buildBundle(join(work, "a"), "source-a");
    const b = buildBundle(join(work, "b"), "source-b");
    const outsideDir = mkdtempSync(join(tmpdir(), "anvil-capability-compose-outside-"));
    try {
      writeFileSync(join(outsideDir, "secret.json"), '{"outside":true}\n');
      symlinkSync(outsideDir, join(work, "linked-outside"), "dir");
      const reviewPath = join(work, "review.yaml");
      writeFileSync(
        reviewPath,
        stringifyYaml(reviewManifestWithEvidence("linked-outside/secret.json"), { lineWidth: 0 }),
      );

      const result = await compose(
        [a, b],
        ["--out", join(work, "out.json"), "--review", reviewPath, "--json"],
      );
      expect(result.code).toBe(1);
      expect(errorJson(result.out)).toMatchObject({ code: "composition/evidence_outside_review" });
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("refuses an evidence sourceRef that does not resolve to any file", async () => {
    const a = buildBundle(join(work, "a"), "source-a");
    const b = buildBundle(join(work, "b"), "source-b");
    const reviewPath = join(work, "review.yaml");
    writeFileSync(
      reviewPath,
      stringifyYaml(reviewManifestWithEvidence("missing.json"), { lineWidth: 0 }),
    );

    const result = await compose(
      [a, b],
      ["--out", join(work, "out.json"), "--review", reviewPath, "--json"],
    );
    expect(result.code).toBe(1);
    expect(errorJson(result.out)).toMatchObject({ code: "composition/evidence_unreadable" });
  });

  it("refuses an evidence sourceRef that is a directory or an empty file", async () => {
    const a = buildBundle(join(work, "a"), "source-a");
    const b = buildBundle(join(work, "b"), "source-b");

    mkdirSync(join(work, "evidence-dir"));
    const dirReviewPath = join(work, "review-dir.yaml");
    writeFileSync(
      dirReviewPath,
      stringifyYaml(reviewManifestWithEvidence("evidence-dir"), { lineWidth: 0 }),
    );
    const dirResult = await compose(
      [a, b],
      ["--out", join(work, "out-dir.json"), "--review", dirReviewPath, "--json"],
    );
    expect(dirResult.code).toBe(1);
    expect(errorJson(dirResult.out)).toMatchObject({
      code: "composition/evidence_not_regular_file",
    });

    writeFileSync(join(work, "empty.json"), "");
    const emptyReviewPath = join(work, "review-empty.yaml");
    writeFileSync(
      emptyReviewPath,
      stringifyYaml(reviewManifestWithEvidence("empty.json"), { lineWidth: 0 }),
    );
    const emptyResult = await compose(
      [a, b],
      ["--out", join(work, "out-empty.json"), "--review", emptyReviewPath, "--json"],
    );
    expect(emptyResult.code).toBe(1);
    expect(errorJson(emptyResult.out)).toMatchObject({
      code: "composition/evidence_not_regular_file",
    });
  });

  it("refuses evidence larger than the offline review limit", async () => {
    const a = buildBundle(join(work, "a"), "source-a");
    const b = buildBundle(join(work, "b"), "source-b");
    writeFileSync(join(work, "huge.json"), Buffer.alloc(1_048_577, "a"));
    const reviewPath = join(work, "review.yaml");
    writeFileSync(
      reviewPath,
      stringifyYaml(reviewManifestWithEvidence("huge.json"), { lineWidth: 0 }),
    );

    const result = await compose(
      [a, b],
      ["--out", join(work, "out.json"), "--review", reviewPath, "--json"],
    );
    expect(result.code).toBe(1);
    expect(errorJson(result.out)).toMatchObject({ code: "composition/evidence_too_large" });
  });
});

describe("anvil capability compose — human-readable output formatting", () => {
  it("prints the boundary summary and scaffold path on a plain --init-review run", async () => {
    const a = buildBundle(join(work, "a"), "source-a");
    const b = buildBundle(join(work, "b"), "source-b");
    const out = join(work, "out.json");
    const scaffold = join(work, "scaffold.yaml");

    const result = await compose([a, b], ["--out", out, "--init-review", scaffold]);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toMatch(
      /^Composition audit: \d+ sources, \d+ operations, \d+ candidate\(s\)\.$/m,
    );
    expect(result.out).toMatch(/^ {2}dispositions: \d+ unresolved, \d+ candidate, \d+ reviewed$/m);
    expect(result.out).toContain(`  report: ${out}`);
    expect(result.out).toMatch(/^ {2}reportHash: sha256:[0-9a-f]{64}$/m);
    expect(result.out).toContain(`  review scaffold: ${scaffold}`);
    expect(result.out).toContain(
      "  boundary: audit/review plan only; no authority inference, MCP generation, approval, build, or deploy.",
    );
    // Plain runs never claim generation/approval/build/deploy happened —
    // asserting this line is present is a direct check on the safety
    // contract's "only approved operations are exposed" boundary.
    expect(result.out).not.toContain("applied review:");
  });
});
