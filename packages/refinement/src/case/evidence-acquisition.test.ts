/**
 * **Evidence acquisition** — the coordinate boundary. Covers what the case protocol
 * conformance suite doesn't: the discriminated-union coordinate shape itself (a
 * malformed coordinate is rejected by the Zod schema, not accepted by a catch-all
 * provider), the async `addEvidence` signature, and dependency-injected acquirers
 * through `CaseService`.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AirDocument, type Claim, loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import type { Deficiency } from "../deficiency.js";
import {
  type AcquisitionContext,
  addEvidence,
  CaseService,
  caseService,
  DEFAULT_EVIDENCE_ACQUIRERS,
  type EvidenceAcquirer,
  type EvidenceCoordinate,
  ExternalArtifactEvidenceAcquirer,
  type FrozenEvidenceArtifact,
  LocalRepositoryEvidenceAcquirer,
  openCase,
  parseEvidenceCoordinate,
  parseEvidenceReport,
} from "../index.js";
import { buildRefinementPlan } from "../plan.js";
import { targetKey } from "../target.js";
import type { CaseWorkspace } from "./identity.js";
import { CASE_OUTPUT } from "./model.js";

/* -------------------------------------------------------------------------- */
/* Fixtures (minimal local copies — mirrors protocol-conformance.test.ts)     */
/* -------------------------------------------------------------------------- */

const REASON_TEXT = "Customer-facing explanation stored with the refund and shown on the receipt.";

function doc(): AirDocument {
  return loadAirDocument({
    service: {
      id: "payments",
      displayName: "Payments",
      version: "2026-07-10",
      source: { kind: "openapi", uri: "./payments.openapi.yaml" },
    },
    operations: [
      {
        id: "payments.refunds.create",
        canonicalName: "create_refund",
        displayName: "Create refund",
        description: "Create a refund against a captured payment.",
        sourceRef: { kind: "openapi", path: "/refunds", method: "post" },
        effect: { kind: "mutation", action: "create", risk: "financial", reversible: false },
        input: {
          params: [{ name: "paymentId", in: "path", required: true, schema: { type: "string" } }],
          body: {
            projection: "fields",
            fields: [{ name: "reason", required: true, schema: { type: "string" } }],
          },
        },
        errors: [{ code: "conflict" }],
        idempotency: { mode: "required", mechanism: "header", header: "Idempotency-Key" },
        retries: { mode: "safe" },
        confirmation: { required: true },
        auth: { type: "api_key" },
        cli: { command: "payments refunds create" },
        mcp: { toolName: "payments_create_refund" },
        skill: { intentExamples: ["Refund a payment."] },
        evidence: { claims: [] as Claim[] },
      },
    ],
  });
}

function reasonDeficiency(air: AirDocument): Deficiency {
  const plan = buildRefinementPlan(air);
  const d = plan.deficiencies.find(
    (x) =>
      x.code === "missing_field_description" && targetKey(x.target).endsWith("input.body.reason"),
  );
  if (!d) throw new Error("fixture did not produce the expected deficiency");
  return d;
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "anvil-evidence-"));
}

function openReasonCase() {
  const air = doc();
  return openCase(air, reasonDeficiency(air), { root: scratch() });
}

/** A temp repository with one source file, for coordinates that need a real path. */
function repoWithSource(): { repo: string; relPath: string } {
  const repo = scratch();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "service.ts"), "// reason: shown on the receipt\n");
  return { repo, relPath: "src/service.ts" };
}

function openReasonCaseWithRepo(repo: string) {
  const air = doc();
  return openCase(air, reasonDeficiency(air), {
    root: scratch(),
    repositoryRoot: repo,
    inspect: ["src"],
  });
}

/* -------------------------------------------------------------------------- */
/* Coordinate validation — the discriminated union rejects malformed shapes   */
/* -------------------------------------------------------------------------- */

describe("evidence coordinate validation", () => {
  it("a local coordinate requires a non-empty path", () => {
    expect(() =>
      parseEvidenceCoordinate({ kind: "local_repository", source: "source_impl", path: "" }),
    ).toThrow();
    expect(() =>
      parseEvidenceCoordinate({ kind: "local_repository", source: "source_impl" }),
    ).toThrow();
  });

  it("add-evidence rejects an empty path", async () => {
    const c = openReasonCase();
    await expect(
      addEvidence(c.dir, {
        predicate: "field.description",
        value: "x",
        source: "source_impl",
        path: "",
      }),
    ).rejects.toThrow();
  });

  it("an external coordinate requires a non-empty uri", () => {
    expect(() =>
      parseEvidenceCoordinate({ kind: "external_artifact", source: "doc_example", uri: "" }),
    ).toThrow();
    expect(() =>
      parseEvidenceCoordinate({ kind: "external_artifact", source: "doc_example" }),
    ).toThrow();
  });

  it("add-evidence rejects an empty uri", async () => {
    const c = openReasonCase();
    await expect(
      addEvidence(c.dir, {
        predicate: "field.description",
        value: "x",
        source: "doc_example",
        uri: "",
      }),
    ).rejects.toThrow();
  });

  it("add-evidence rejects supplying both a path and a uri/ref", async () => {
    const c = openReasonCase();
    await expect(
      addEvidence(c.dir, {
        predicate: "field.description",
        value: "x",
        source: "source_impl",
        path: "src/x.ts",
        uri: "docs://x",
      }),
    ).rejects.toThrow(/both a filesystem path and a uri/);
    await expect(
      addEvidence(c.dir, {
        predicate: "field.description",
        value: "x",
        source: "source_impl",
        path: "src/x.ts",
        ref: "docs://x",
      }),
    ).rejects.toThrow(/both a filesystem path and a uri/);
  });

  it("add-evidence rejects supplying neither a path nor a uri/ref", async () => {
    const c = openReasonCase();
    await expect(
      addEvidence(c.dir, { predicate: "field.description", value: "x", source: "source_impl" }),
    ).rejects.toThrow(/needs either a filesystem path.*or a source uri/);
  });

  it("parseEvidenceCoordinate rejects a structurally malformed object", () => {
    expect(() => parseEvidenceCoordinate({ kind: "local_repository" })).toThrow();
    expect(() => parseEvidenceCoordinate({ kind: "bogus" })).toThrow();
    expect(() => parseEvidenceCoordinate({})).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* addEvidence is genuinely async                                             */
/* -------------------------------------------------------------------------- */

describe("addEvidence is async", () => {
  it("returns a Promise (every call site requires await)", () => {
    const c = openReasonCase();
    const result = addEvidence(c.dir, {
      predicate: "field.description",
      value: REASON_TEXT,
      source: "source_impl",
      ref: "s:1",
    });
    expect(result).toBeInstanceOf(Promise);
    // Prevent an unhandled-rejection warning; the resolution itself is exercised
    // by every other test in this file.
    return result;
  });
});

/* -------------------------------------------------------------------------- */
/* Verification field — the single source of verification truth                */
/* -------------------------------------------------------------------------- */

describe("evidence verification field", () => {
  it("a local artifact is verified with verifier local_repository", async () => {
    const { repo, relPath } = repoWithSource();
    const c = openReasonCaseWithRepo(repo);
    await addEvidence(c.dir, {
      predicate: "field.description",
      value: REASON_TEXT,
      source: "source_impl",
      path: relPath,
    });
    const report = JSON.parse(readFileSync(join(c.dir, CASE_OUTPUT.research), "utf8"));
    const art = report.artifacts[0];
    expect(art.verification).toEqual({ status: "verified", verifier: "local_repository" });
    // Verification lives only in `verification.status`; there is no standalone boolean.
    expect(art.verified).toBeUndefined();
  });

  it("an external artifact is unverified with a reason string", async () => {
    const c = openReasonCase();
    await addEvidence(c.dir, {
      predicate: "field.description",
      value: REASON_TEXT,
      source: "doc_example",
      uri: "docs://refunds#reason",
      excerpt: "reason is shown on the receipt",
    });
    const report = JSON.parse(readFileSync(join(c.dir, CASE_OUTPUT.research), "utf8"));
    const art = report.artifacts[0];
    expect(art.verification.status).toBe("unverified");
    expect(typeof art.verification.reason).toBe("string");
    expect(art.verification.reason.length).toBeGreaterThan(0);
    expect(art.verified).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Artifact identity — coordinate + revision + content, never content alone    */
/* -------------------------------------------------------------------------- */

describe("evidence artifact identity", () => {
  /** A repo with two distinct files that contain the SAME excerpt line. */
  function repoWithTwins(): { workspace: CaseWorkspace; revision: string } {
    const repo = scratch();
    mkdirSync(join(repo, "src"), { recursive: true });
    const line = "// reason: shown on the receipt\n";
    writeFileSync(join(repo, "src", "a.ts"), line);
    writeFileSync(join(repo, "src", "b.ts"), line);
    return {
      workspace: { repositoryRoot: repo, repositoryRevision: "rev-1", inspectScopes: [repo] },
      revision: "rev-1",
    };
  }

  const local = new LocalRepositoryEvidenceAcquirer();

  it("gives the same excerpt at two different files different ids", async () => {
    const { workspace } = repoWithTwins();
    const a = await local.acquire(
      {
        kind: "local_repository",
        source: "source_impl",
        path: "src/a.ts",
        startLine: 1,
        endLine: 1,
      },
      { workspace, now: 1 },
    );
    const b = await local.acquire(
      {
        kind: "local_repository",
        source: "source_impl",
        path: "src/b.ts",
        startLine: 1,
        endLine: 1,
      },
      { workspace, now: 1 },
    );
    expect(a.contentHash).toBe(b.contentHash); // identical bytes
    expect(a.id).not.toBe(b.id); // but independent provenance → different identity
  });

  it("gives the same file/span/revision/content a stable id", async () => {
    const { workspace } = repoWithTwins();
    const coord = {
      kind: "local_repository" as const,
      source: "source_impl" as const,
      path: "src/a.ts",
      startLine: 1,
      endLine: 1,
    };
    const a = await local.acquire(coord, { workspace, now: 1 });
    const b = await local.acquire(coord, { workspace, now: 999 }); // time does not affect identity
    expect(a.id).toBe(b.id);
  });

  it("changes the id when the repository revision changes", async () => {
    const { workspace } = repoWithTwins();
    const coord = {
      kind: "local_repository" as const,
      source: "source_impl" as const,
      path: "src/a.ts",
      startLine: 1,
      endLine: 1,
    };
    const atRev1 = await local.acquire(coord, { workspace, now: 1 });
    const atRev2 = await local.acquire(coord, {
      workspace: { ...workspace, repositoryRevision: "rev-2" },
      now: 1,
    });
    expect(atRev1.id).not.toBe(atRev2.id);
  });

  it("gives external artifacts with different uris different ids", async () => {
    const external = new ExternalArtifactEvidenceAcquirer();
    const ctx: AcquisitionContext = {
      workspace: { repositoryRoot: "/repo", inspectScopes: [] },
      now: 1,
    };
    const a = await external.acquire(
      { kind: "external_artifact", source: "doc_example", uri: "docs://x", excerpt: "same text" },
      ctx,
    );
    const b = await external.acquire(
      { kind: "external_artifact", source: "doc_example", uri: "docs://y", excerpt: "same text" },
      ctx,
    );
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.id).not.toBe(b.id);
  });
});

/* -------------------------------------------------------------------------- */
/* Verified artifacts must be re-hashable (no pathless "verified")            */
/* -------------------------------------------------------------------------- */

describe("verified artifact identity requires a re-readable coordinate", () => {
  it("parseEvidenceReport rejects a pathless verified artifact", () => {
    const forged = {
      artifacts: [
        {
          id: "forged",
          uri: "fake://x",
          source: "source_impl",
          contentHash: "deadbeef",
          excerpt: "claimed",
          acquiredAt: new Date(0).toISOString(),
          // verified, but no `path` → cannot be re-hashed → rejected at the boundary.
          verification: { status: "verified", verifier: "local_repository" },
        },
      ],
    };
    expect(() => parseEvidenceReport(forged)).toThrow();
  });

  it("accepts a verified artifact that carries a path", () => {
    const ok = {
      artifacts: [
        {
          id: "real",
          uri: "src/x.ts#L1-L1",
          source: "source_impl",
          contentHash: "deadbeef",
          excerpt: "claimed",
          acquiredAt: new Date(0).toISOString(),
          path: "src/x.ts",
          startLine: 1,
          endLine: 1,
          verification: { status: "verified", verifier: "local_repository" },
        },
      ],
    };
    expect(() => parseEvidenceReport(ok)).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Injectable acquirers via CaseService                                       */
/* -------------------------------------------------------------------------- */

describe("CaseService injects custom evidence acquirers", () => {
  it("uses the injected acquirer instead of the default local provider", async () => {
    const air = doc();
    const deficiency = reasonDeficiency(air);
    const c = openCase(air, deficiency, { root: scratch() });

    let calls = 0;
    const fakeArtifact: FrozenEvidenceArtifact = {
      id: "fake000001",
      uri: "fake://source",
      source: "source_impl",
      contentHash: "deadbeef",
      excerpt: "hand-crafted excerpt from the fake acquirer",
      acquiredAt: new Date(0).toISOString(),
      // A verified artifact must carry a re-readable path coordinate.
      path: "fake/source.ts",
      startLine: 1,
      endLine: 1,
      verification: { status: "verified", verifier: "local_repository" },
    };
    const fakeAcquirer: EvidenceAcquirer = {
      kind: "local_repository",
      async acquire(
        _coordinate: EvidenceCoordinate,
        _context: AcquisitionContext,
      ): Promise<FrozenEvidenceArtifact> {
        calls += 1;
        return fakeArtifact;
      },
    };
    // Keep the external provider so a bare uri coordinate still resolves if ever used.
    const externalAcquirer = DEFAULT_EVIDENCE_ACQUIRERS.find((a) => a.kind === "external_artifact");
    if (!externalAcquirer) throw new Error("no default external acquirer");

    const service = new CaseService({ evidenceAcquirers: [fakeAcquirer, externalAcquirer] });
    const summary = await service.addEvidence(c.dir, {
      predicate: "field.description",
      value: REASON_TEXT,
      source: "source_impl",
      path: "src/service.ts", // any local-shaped coordinate — the fake ignores it
    });

    expect(calls).toBe(1);
    expect(summary).toContain(fakeArtifact.id);
    const report = JSON.parse(readFileSync(join(c.dir, CASE_OUTPUT.research), "utf8"));
    expect(report.artifacts).toHaveLength(1);
    expect(report.artifacts[0].id).toBe(fakeArtifact.id);
    expect(report.artifacts[0].excerpt).toBe(fakeArtifact.excerpt);
  });

  it("caseService.addEvidence (default export) still uses the default acquirers", async () => {
    const c = openReasonCase();
    // The default singleton (not constructed with injection here) should still work
    // unchanged for callers who don't need it.
    await expect(
      caseService.addEvidence(c.dir, {
        predicate: "field.description",
        value: REASON_TEXT,
        source: "source_impl",
        uri: "docs://x",
      }),
    ).resolves.toContain("Recorded");
  });
});
