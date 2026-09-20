import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, ManifestParseError } from "@anvil/compiler";
import { afterEach, describe, expect, it } from "vitest";
import { previewCapabilityDecision, previewOperationApproval } from "./approval-preview.js";
import {
  APPROVAL_RECORD_FILE,
  ApprovalRecord,
  normalizeReviewer,
  readApprovalRecords,
  summarizeApprovalRecords,
  UNRECORDED_REVIEWER,
} from "./approval-record.js";
import { generateBundle, writeBundle } from "./bundle.js";
import { listBundleHistory, resolveHistoryLimit } from "./bundle-history.js";
import { loadBundleAir } from "./bundle-io.js";
import {
  BUNDLE_MANIFEST_FILE,
  readBundleManifest,
  recordBundleManifest,
  validateBundleManifest,
  writeBundleManifest,
} from "./bundle-manifest.js";
import {
  approveCapabilityInBundle,
  approveOperationsInBundle,
  rejectCapabilityInBundle,
  reprojectBundleAtomically,
} from "./bundle-reproject.js";
import { prepareRollback, rollbackBundle } from "./bundle-rollback.js";
import { bundleHash, readBundleDir } from "./certify.js";

/**
 * The review-workflow trust surface: every decision leaves an append-only
 * record naming who decided what and the bundle hash before and after; every
 * swap retains the replaced generation (bounded) so `anvil rollback` can
 * restore it byte for byte; a dry run runs the same gates and writes nothing;
 * and the manifest copy beside a bundle is validated by the compiler's own
 * parser before it is written. All over the real payments bundle.
 */

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "anvil-review-trust-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A compiled payments bundle with no manifest: several operations sit in review_required. */
async function paymentsBundle(): Promise<string> {
  const air = await compile({ spec: read("openapi.yaml"), serviceId: "payments" });
  const dir = join(freshDir(), "payments");
  writeBundle(dir, generateBundle(air));
  return dir;
}

const airOf = (dir: string) => loadBundleAir(dir, readBundleDir(dir));
const pendingIds = (dir: string) =>
  airOf(dir)
    .operations.filter((op) => op.state === "review_required")
    .map((op) => op.id);
const clock = (iso: string) => () => new Date(iso);

describe("normalizeReviewer", () => {
  it("records 'unrecorded' explicitly when no identity is given", () => {
    expect(normalizeReviewer(undefined)).toBe(UNRECORDED_REVIEWER);
    expect(normalizeReviewer("  ana@example.test ")).toBe("ana@example.test");
  });

  it("refuses an empty identity rather than coercing it", () => {
    expect(() => normalizeReviewer("")).toThrow(/must not be empty/);
    expect(() => normalizeReviewer("   ")).toThrow(/must not be empty/);
  });
});

describe("the approval record", () => {
  it("appends one line per decision with reviewer, states, note, and both hashes", async () => {
    const dir = await paymentsBundle();
    const [first, second] = pendingIds(dir);
    if (!first || !second) throw new Error("fixture has fewer than two pending operations");
    const before = bundleHash(readBundleDir(dir));

    const result = approveOperationsInBundle(
      dir,
      [first],
      { now: clock("2026-09-20T10:00:00.000Z") },
      { reviewer: "ana@example.test", note: "read-only lookup" },
    );
    const after = bundleHash(readBundleDir(dir));
    expect(result.reprojection.record).toEqual({
      schemaVersion: 1,
      recordedAt: "2026-09-20T10:00:00.000Z",
      reviewer: "ana@example.test",
      action: "approve_operations",
      subjects: [{ kind: "operation", id: first, from: "review_required", to: "approved" }],
      bundleHash: { before, after },
      note: "read-only lookup",
    });
    expect(after).not.toBe(before);

    // No identity: recorded as "unrecorded", never omitted, never invented.
    approveOperationsInBundle(dir, [second], { now: clock("2026-09-20T10:01:00.000Z") });
    const records = readApprovalRecords(dir);
    expect(records).toHaveLength(2);
    expect(records[1]?.reviewer).toBe(UNRECORDED_REVIEWER);
    expect(records[1]?.bundleHash.before).toBe(after);
    expect(records[1]?.bundleHash.after).toBe(bundleHash(readBundleDir(dir)));
    // The log is not part of the bundle's bytes it hashes.
    expect(readBundleDir(dir)[APPROVAL_RECORD_FILE]).toBeUndefined();
    expect(readFileSync(join(dir, APPROVAL_RECORD_FILE), "utf8").trim().split("\n")).toHaveLength(
      2,
    );
    expect(summarizeApprovalRecords(records)).toContain("2 decision(s)");
    expect(summarizeApprovalRecords(records)).toContain(`by ${UNRECORDED_REVIEWER}`);
  });

  it("refuses an empty reviewer before anything is written", async () => {
    const dir = await paymentsBundle();
    const [id] = pendingIds(dir);
    const snapshot = readBundleDir(dir);
    expect(() => approveOperationsInBundle(dir, [id as string], {}, { reviewer: " " })).toThrow(
      /must not be empty/,
    );
    expect(readBundleDir(dir)).toEqual(snapshot);
    expect(existsSync(join(dir, APPROVAL_RECORD_FILE))).toBe(false);
  });

  it("records capability decisions with the lifecycle that moved and the reason", async () => {
    const dir = await paymentsBundle();
    const [toApprove, toReject] = airOf(dir).capabilities.map((cap) => cap.id);
    if (!toApprove || !toReject) throw new Error("fixture has fewer than two capabilities");
    approveCapabilityInBundle(dir, toApprove, {}, { reviewer: "ana" });
    rejectCapabilityInBundle(dir, toReject, "not a task boundary", { reviewer: "ana" });
    const [approved, rejected] = readApprovalRecords(dir);
    expect(approved?.action).toBe("approve_capability");
    expect(approved?.subjects).toEqual([
      { kind: "capability", id: toApprove, from: "proposed", to: "approved" },
    ]);
    expect(rejected?.action).toBe("reject_capability");
    expect(rejected?.subjects[0]?.to).toBe("rejected");
    expect(rejected?.note).toBe("not a task boundary");
  });

  it("names a malformed line instead of skipping it", async () => {
    const dir = await paymentsBundle();
    approveOperationsInBundle(dir, [pendingIds(dir)[0] as string]);
    writeFileSync(join(dir, APPROVAL_RECORD_FILE), "{not json}\n", { flag: "a" });
    expect(() => readApprovalRecords(dir)).toThrow(/approvals\.jsonl:2 is not valid JSON/);
    expect(() => ApprovalRecord.parse({ schemaVersion: 1 })).toThrow();
  });
});

describe("bundle history", () => {
  it("retains the replaced generation byte for byte, outside the bundle's own bytes", async () => {
    const dir = await paymentsBundle();
    const prior = readBundleDir(dir);
    const priorHash = bundleHash(prior);
    const result = approveOperationsInBundle(dir, [pendingIds(dir)[0] as string], {
      now: clock("2026-09-20T10:00:00.000Z"),
    });
    const entry = result.reprojection.history;
    expect(entry?.id).toBe(`2026-09-20T10-00-00-000Z-${priorHash.slice(0, 12)}`);
    expect(entry?.bundleHash).toBe(priorHash);
    expect(readBundleDir(entry?.path as string)).toEqual(prior);
    // Neither the entry nor the record leaks into the live bundle's identity.
    expect(Object.keys(readBundleDir(dir)).some((rel) => rel.startsWith(".anvil/"))).toBe(false);
    expect(listBundleHistory(dir).map((e) => e.id)).toEqual([entry?.id]);
    // No stray sibling directories: the backup became the history entry.
    expect(readdirSync(join(dir, "..")).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it("is bounded to the configured limit and never nests generations", async () => {
    const dir = await paymentsBundle();
    // Every decision is a swap: the pending operations, then each capability.
    const decisions: Array<(deps: { historyLimit: number; now: () => Date }) => unknown> = [
      ...pendingIds(dir).map(
        (id) => (deps: { historyLimit: number; now: () => Date }) =>
          approveOperationsInBundle(dir, [id], deps),
      ),
      ...airOf(dir).capabilities.map(
        (cap) => (deps: { historyLimit: number; now: () => Date }) =>
          rejectCapabilityInBundle(dir, cap.id, "bounded-history test", {}, deps),
      ),
    ];
    expect(decisions.length).toBeGreaterThanOrEqual(3);
    let tick = 0;
    for (const decide of decisions) {
      decide({ historyLimit: 2, now: () => new Date(Date.UTC(2026, 8, 20, 10, tick++)) });
    }
    const history = listBundleHistory(dir);
    expect(history).toHaveLength(2);
    // Newest first, and the newest entry is the generation just replaced.
    expect(history[0]?.recordedAt > (history[1]?.recordedAt as string)).toBe(true);
    for (const entry of history) {
      expect(existsSync(join(entry.path, ".anvil", "history"))).toBe(false);
    }
    // Every swap was recorded, including those whose generation was pruned.
    expect(readApprovalRecords(dir)).toHaveLength(decisions.length);
  });

  it("resolves the limit from the environment and refuses a nonsensical one", () => {
    expect(resolveHistoryLimit(3)).toBe(3);
    expect(resolveHistoryLimit()).toBe(5);
    process.env.ANVIL_BUNDLE_HISTORY_LIMIT = "1";
    try {
      expect(resolveHistoryLimit()).toBe(1);
      expect(resolveHistoryLimit(0)).toBe(0);
    } finally {
      delete process.env.ANVIL_BUNDLE_HISTORY_LIMIT;
    }
    expect(() => resolveHistoryLimit(-1)).toThrow(/non-negative integer/);
  });

  it("with a limit of zero keeps no generation but still records the decision", async () => {
    const dir = await paymentsBundle();
    const result = approveOperationsInBundle(dir, [pendingIds(dir)[0] as string], {
      historyLimit: 0,
    });
    expect(result.reprojection.history).toBeUndefined();
    expect(listBundleHistory(dir)).toEqual([]);
    expect(readApprovalRecords(dir)).toHaveLength(1);
  });
});

describe("the pre-approval preview", () => {
  it("names what would change on every surface and writes nothing", async () => {
    const dir = await paymentsBundle();
    const [id] = pendingIds(dir);
    const op = airOf(dir).operations.find((candidate) => candidate.id === id);
    const snapshot = readBundleDir(dir);

    const preview = previewOperationApproval(dir, [id as string]);
    expect(preview.subjects).toEqual([
      { kind: "operation", id, from: "review_required", to: "approved" },
    ]);
    expect(preview.mcpTools.added).toEqual([op?.mcp.toolName]);
    expect(preview.mcpTools.removed).toEqual([]);
    expect(preview.cliCommands.added).toEqual([op?.cli.command]);
    expect(preview.skillFiles).toContain("skill/SKILL.md");
    expect(preview.regeneratedFiles).toContain("mcp/air.json");
    expect(preview.regeneratedFiles).toContain("air.yaml");
    expect(preview.projectionsChanged).toBe(true);
    expect(preview.regeneratedFiles.length).toBeLessThanOrEqual(preview.generatedFileCount);

    expect(readBundleDir(dir)).toEqual(snapshot);
    expect(existsSync(join(dir, ".anvil"))).toBe(false);
    expect(readdirSync(join(dir, "..")).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it("refuses exactly what the real approval refuses", async () => {
    const dir = await paymentsBundle();
    expect(() => previewOperationApproval(dir, ["payments.nope"])).toThrow(
      /Unknown operation id\(s\): payments.nope/,
    );
    expect(() => approveOperationsInBundle(dir, ["payments.nope"])).toThrow(
      /Unknown operation id\(s\): payments.nope/,
    );
  });

  it("previews a capability decision through the compiler's review gate", async () => {
    const dir = await paymentsBundle();
    const cap = airOf(dir).capabilities[0];
    if (!cap) throw new Error("fixture has no capability");
    const preview = previewCapabilityDecision(dir, cap.id, "reject", { reason: "no" });
    expect(preview.subjects).toEqual([
      { kind: "capability", id: cap.id, from: "proposed", to: "rejected" },
    ]);
    expect(preview.mcpTools.added).toEqual([]);
    expect(airOf(dir).capabilities.find((c) => c.id === cap.id)?.lifecycle).toBe("proposed");
    expect(() => previewCapabilityDecision(dir, "nope", "approve")).toThrow(/nope/);
  });
});

describe("rollback", () => {
  it("restores the retained generation atomically and records the states that moved back", async () => {
    const dir = await paymentsBundle();
    const [id] = pendingIds(dir);
    const original = readBundleDir(dir);
    approveOperationsInBundle(dir, [id as string], {
      now: clock("2026-09-20T10:00:00.000Z"),
    });
    expect(airOf(dir).operations.find((op) => op.id === id)?.state).toBe("approved");
    const approvedFiles = readBundleDir(dir);

    const result = rollbackBundle(dir, {
      reviewer: "ana",
      note: "approved by mistake",
      deps: { now: clock("2026-09-20T11:00:00.000Z") },
    });
    expect(readBundleDir(dir)).toEqual(original);
    expect(airOf(dir).operations.find((op) => op.id === id)?.state).toBe("review_required");
    expect(result.reprojection.record.action).toBe("rollback");
    expect(result.reprojection.record.reviewer).toBe("ana");
    expect(result.reprojection.record.bundleHash).toEqual({
      before: bundleHash(approvedFiles),
      after: bundleHash(original),
    });
    expect(result.subjects).toEqual([
      {
        kind: "generation",
        id: result.restored.id,
        from: bundleHash(approvedFiles),
        to: bundleHash(original),
      },
      { kind: "operation", id, from: "approved", to: "review_required" },
    ]);
    // The record continues across the rollback: the approval line is still there.
    expect(readApprovalRecords(dir).map((record) => record.action)).toEqual([
      "approve_operations",
      "rollback",
    ]);
    // The approved generation is retained in turn, so the rollback can itself be undone.
    const history = listBundleHistory(dir);
    expect(history[0]?.bundleHash).toBe(bundleHash(approvedFiles));
    expect(readBundleDir(history[0]?.path as string)).toEqual(approvedFiles);
  });

  it("selects a generation by hash prefix and refuses an ambiguous or unknown one", async () => {
    const dir = await paymentsBundle();
    const [first, second] = pendingIds(dir);
    const g0 = bundleHash(readBundleDir(dir));
    approveOperationsInBundle(dir, [first as string]);
    const g1 = bundleHash(readBundleDir(dir));
    approveOperationsInBundle(dir, [second as string]);

    expect(() => rollbackBundle(dir, { to: "zz" })).toThrow(/hex prefix/);
    expect(() => rollbackBundle(dir, { to: "0".repeat(64) })).toThrow(/No retained generation/);
    const prepared = prepareRollback(dir, g0.slice(0, 12));
    expect(prepared.restored.bundleHash).toBe(g0);
    rollbackBundle(dir, { to: g0 });
    expect(bundleHash(readBundleDir(dir))).toBe(g0);
    expect(listBundleHistory(dir).map((entry) => entry.bundleHash)).toContain(g1);
  });

  it("refuses a retained generation this toolchain cannot reproduce", async () => {
    const dir = await paymentsBundle();
    approveOperationsInBundle(dir, [pendingIds(dir)[0] as string]);
    const [entry] = listBundleHistory(dir);
    writeFileSync(join(entry?.path as string, "mcp", "air.json"), "{}\n", "utf8");
    const live = readBundleDir(dir);
    expect(() => rollbackBundle(dir)).toThrow(/cannot be reproduced|not what this toolchain/);
    expect(readBundleDir(dir)).toEqual(live);
  });

  it("says so when there is nothing to roll back to", async () => {
    const dir = await paymentsBundle();
    expect(() => rollbackBundle(dir)).toThrow(/nothing to roll back to/);
  });
});

describe("a plain reprojection", () => {
  it("is recorded as such, with no subjects and an unrecorded reviewer", async () => {
    const dir = await paymentsBundle();
    const result = reprojectBundleAtomically(dir, airOf(dir));
    expect(result.projectionsChanged).toBe(false);
    expect(result.record.action).toBe("reproject");
    expect(result.record.subjects).toEqual([]);
    expect(result.record.reviewer).toBe(UNRECORDED_REVIEWER);
    expect(result.record.bundleHash.before).toBe(result.record.bundleHash.after);
  });
});

describe("the bundle's manifest copy", () => {
  it("is recorded beside the bundle, outside its bytes, and removed when a compile has none", async () => {
    const dir = await paymentsBundle();
    expect(readBundleManifest(dir)).toEqual({
      path: join(dir, ".anvil", "manifest.yaml"),
      exists: false,
      text: "",
    });
    recordBundleManifest(dir, read("anvil.yaml"));
    expect(readBundleManifest(dir).text).toBe(read("anvil.yaml"));
    expect(readBundleDir(dir)[BUNDLE_MANIFEST_FILE]).toBeUndefined();
    recordBundleManifest(dir, undefined);
    expect(readBundleManifest(dir).exists).toBe(false);
  });

  it("validates with the compiler's parser and refuses to write an invalid manifest", async () => {
    const dir = await paymentsBundle();
    const invalid = "operations:\n  createRefund:\n    idempotancy: natural\n";
    const validation = validateBundleManifest(invalid);
    expect(validation.ok).toBe(false);
    if (validation.ok) throw new Error("unreachable");
    expect(validation.issues[0]).toMatchObject({
      path: "operations.createRefund.idempotancy",
      line: 3,
      suggestion: "idempotency",
    });
    expect(() => writeBundleManifest(dir, invalid)).toThrow(ManifestParseError);
    expect(readBundleManifest(dir).exists).toBe(false);

    const valid = read("anvil.yaml");
    expect(validateBundleManifest(valid)).toEqual({ ok: true, issues: [] });
    const path = writeBundleManifest(dir, valid);
    expect(readFileSync(path, "utf8")).toBe(valid);
    // Atomic: no temp file survives the rename.
    expect(readdirSync(join(dir, ".anvil"))).toEqual(["manifest.yaml"]);
  });

  it("refuses a manifest written for a newer toolchain", () => {
    const validation = validateBundleManifest("version: 99.0.0\n");
    expect(validation.ok).toBe(false);
    if (validation.ok) throw new Error("unreachable");
    expect(validation.issues[0]).toMatchObject({ path: "version", line: 1 });
    expect(validation.issues[0]?.message).toMatch(/newer than this toolchain/);
    expect(validateBundleManifest("version: 0.1.0\n").ok).toBe(true);
  });
});
