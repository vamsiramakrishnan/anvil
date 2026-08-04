import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FileSystemGatewayImportReceiptStore,
  finalizeGatewayImportReceipt,
  type GatewayImportReceipt,
  type GatewayImportReceiptDraft,
  gatewayBundleManifest,
  gatewayImportIdentity,
  gatewaySha256,
  redactGatewayImportReceipt,
} from "@anvil/compiler";
import type { GeneratedBundle } from "@anvil/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exactFileSetDiagnostics, prepareBundleInstall } from "./estate-bundle-install.js";

/**
 * Characterisation of the transactional bundle install.
 *
 * An error-code coverage map over `estate.ts` found 40 of its 57 codes asserted
 * somewhere in the workspace and 17 not — and thirteen of the seventeen were in
 * this subsystem, which is the one that deletes and replaces directories. They
 * were untested because they were unreachable: the code was private to a
 * 3,327-line module. This file is what the extraction was for.
 *
 * The invariant that matters most is the transactional one: an interrupted
 * install leaves either the old complete bundle or the new complete bundle, never
 * a mixture, and never a directory whose files the receipt cannot account for.
 */

const EXPORT_BYTES = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10, 0x00, 0x7f, 0x42]);

const AIR_JSON = JSON.stringify({
  service: { id: "acct", version: "2026-07-12", source: { kind: "openapi", uri: "./a.yaml" } },
  operations: [],
});

/** The files a generated bundle carries in these tests, plus its receipt view. */
function bundleFiles(air = AIR_JSON): Record<string, string> {
  return { "air.json": air, "README.md": "# acct\n" };
}

/**
 * The identity digests are derived, never hand-written: the receipt store
 * recomputes them and refuses a receipt whose identity does not reproduce. A
 * fixture with invented digests would test nothing but the store's rejection.
 * `apiId` is the axis varied to produce a genuinely different coordinate.
 */
function identityFor(apiId: string) {
  return gatewayImportIdentity({
    vendor: "kong",
    gatewayId: "gw-123",
    apiId,
    serviceId: "acct",
    environment: "prod",
    revision: "1.0",
    gatewayIdSource: "export",
    exportDigest: gatewaySha256(EXPORT_BYTES),
    inventoryDigest: "inv-digest",
  });
}

function draftFor(files: Record<string, string>, apiId = "test-api"): GatewayImportReceiptDraft {
  return {
    schemaVersion: 1,
    receiptType: "anvil.gateway-import",
    selection: {
      vendor: "kong",
      apiId,
      identity: identityFor(apiId),
      export: {
        format: "zip",
        sha256: gatewaySha256(EXPORT_BYTES),
        bytes: EXPORT_BYTES.byteLength,
        storedAs: "raw/export.bin",
      },
    },
    inventory: { digest: "inv-digest" },
    contract: {
      provenance: {
        kind: "synthesized",
        fidelity: "route_only",
        format: "openapi",
        version: "3.0.3",
        location: { origin: "/export.zip", pointer: "/services/0" },
      },
      compilerSource: {
        snapshotId: "snap-1",
        sourceHash: "sha256:abc123",
        entrypoint: "api.yaml",
      },
    },
    overlays: [],
    diagnostics: [],
    blockers: [],
    output: gatewayBundleManifest(files),
  };
}

let work: string;
let store: FileSystemGatewayImportReceiptStore;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-bundle-install-"));
  store = new FileSystemGatewayImportReceiptStore(join(work, ".anvil", "imports"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

interface Scenario {
  receipt: GatewayImportReceipt;
  /** Content files plus the receipt view, exactly as `runImport` composes them. */
  files: Record<string, string>;
}

/**
 * Build an import the way `runImport` does: finalize the receipt over the content
 * files, persist it, then add its redacted view to the bundle. The view is not in
 * the receipt's own output manifest — it could not be, since it carries that
 * manifest's digest — so the two file sets differ by exactly that one entry.
 */
async function scenario(content: Record<string, string>, apiId = "test-api"): Promise<Scenario> {
  const receipt = finalizeGatewayImportReceipt(draftFor(content, apiId));
  const created = await store.create(receipt, EXPORT_BYTES);
  expect(created.ok, JSON.stringify(created)).toBe(true);
  return { receipt, files: withReceiptView(content, receipt) };
}

function withReceiptView(
  content: Record<string, string>,
  receipt: GatewayImportReceipt,
): Record<string, string> {
  return {
    ...content,
    "import.receipt.json": `${JSON.stringify(
      redactGatewayImportReceipt(receipt, { workspaceRoot: work }),
      null,
      2,
    )}\n`,
  };
}

function install(
  outDir: string,
  files: Record<string, string>,
  receipt: GatewayImportReceipt,
  replaceDerived = false,
  deps = {},
) {
  const bundle: GeneratedBundle = { files };
  return prepareBundleInstall(outDir, bundle, receipt, store, work, replaceDerived, deps);
}

/** Write a bundle directory as a completed prior install would have left it. */
function writeInstalled(dir: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text, "utf8");
  }
}

const codes = (result: Awaited<ReturnType<typeof install>>): string[] =>
  result.ok ? [] : result.diagnostics.map((d) => d.code);

/* -------------------------------------------------------------------------- */
/* The happy path, so the failure cases below are known to be failures         */
/* -------------------------------------------------------------------------- */

describe("prepareBundleInstall — installing", () => {
  it("stages, verifies, and swaps a fresh bundle into place", async () => {
    const { receipt, files } = await scenario(bundleFiles());
    const out = join(work, "bundle");

    const result = await install(out, files, receipt);
    expect(codes(result)).toEqual([]);
    if (!result.ok) throw new Error("expected install to prepare");

    expect(result.commit()).toEqual({});
    expect(readFileSync(join(out, "air.json"), "utf8")).toBe(AIR_JSON);
    expect(existsSync(join(out, "import.receipt.json"))).toBe(true);
  });

  it("leaves no staging directory behind on success or on refusal", async () => {
    const { receipt, files } = await scenario(bundleFiles());

    const ok = await install(join(work, "bundle"), files, receipt);
    if (ok.ok) ok.commit();
    // Refused: the staged copy must be cleaned up on the failure path too.
    await install(join(work, "bundle2"), { "air.json": "{ divergent" }, receipt);

    const strays = readdirSync(work).filter(
      (name) => name.includes("anvil-stage-") || name.includes("anvil-previous-"),
    );
    expect(strays, "a refused install left staging state behind").toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The transactional invariant                                                 */
/* -------------------------------------------------------------------------- */

describe("prepareBundleInstall — the install is transactional", () => {
  it("rollback restores the previous bundle exactly, byte for byte", async () => {
    const old = await scenario({ "air.json": AIR_JSON, "README.md": "# old\n" });
    const out = join(work, "bundle");
    writeInstalled(out, old.files);
    const before = readFileSync(join(out, "README.md"), "utf8");

    // A second import of the same gateway identity, carrying different content.
    const next = await scenario({ "air.json": AIR_JSON, "README.md": "# new\n" });

    const result = await install(out, next.files, next.receipt);
    if (!result.ok) throw new Error(`expected prepare, got ${codes(result).join(", ")}`);

    // The new bundle is in place before the decision to keep it.
    expect(readFileSync(join(out, "README.md"), "utf8")).toBe("# new\n");
    result.rollback();

    // ...and rolling back returns the old one whole, not a merge of the two.
    expect(readFileSync(join(out, "README.md"), "utf8")).toBe(before);
    expect(readFileSync(join(out, "air.json"), "utf8")).toBe(AIR_JSON);
  });

  it("commit is idempotent and rollback after commit is inert", async () => {
    const { receipt, files } = await scenario(bundleFiles());
    const out = join(work, "bundle");

    const result = await install(out, files, receipt);
    if (!result.ok) throw new Error("expected prepare");
    expect(result.commit()).toEqual({});
    expect(result.commit()).toEqual({});
    result.rollback();
    expect(existsSync(join(out, "air.json"))).toBe(true);
  });

  it("reports a retained backup rather than claiming a clean install", async () => {
    const old = await scenario({ "air.json": AIR_JSON, "README.md": "# old\n" });
    const out = join(work, "bundle");
    writeInstalled(out, old.files);

    const next = await scenario({ "air.json": AIR_JSON, "README.md": "# new\n" });

    const result = await install(out, next.files, next.receipt, false, {
      cleanupGatewayBundleBackup: () => {
        throw new Error("disk is read-only");
      },
    });
    if (!result.ok) throw new Error("expected prepare");

    const outcome = result.commit();
    expect(outcome.retainedBackup).toBeDefined();
    expect(outcome.warning).toContain("could not be removed");
    expect(outcome.warning).toContain("disk is read-only");
    // The install still succeeded — a cleanup failure must not be reported as one.
    expect(readFileSync(join(out, "README.md"), "utf8")).toBe("# new\n");
  });
});

/* -------------------------------------------------------------------------- */
/* Refusals that had no assertion anywhere                                     */
/* -------------------------------------------------------------------------- */

describe("prepareBundleInstall — refusals", () => {
  it("refuses a filesystem-root output path before staging anything", async () => {
    const { receipt, files } = await scenario(bundleFiles());
    expect(codes(await install("/", files, receipt))).toEqual([
      "gateway_receipt/unsafe_output_path",
    ]);
  });

  it("refuses when the staged bundle does not match the receipt manifest", async () => {
    // The receipt is minted for one file set; the bundle carries another. Staged
    // bytes are checked against the immutable manifest before anything is swapped.
    const { receipt } = await scenario(bundleFiles());
    const divergent = withReceiptView(
      { "air.json": AIR_JSON, "README.md": "# tampered\n" },
      receipt,
    );

    const result = await install(join(work, "bundle"), divergent, receipt);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("gateway_receipt/output_changed");
    // Nothing was installed: a refusal must not leave a partial directory.
    expect(existsSync(join(work, "bundle"))).toBe(false);
  });

  it("refuses an existing output whose canonical AIR cannot be read", async () => {
    const old = await scenario({ "air.json": "{ not json", "README.md": "# old\n" });
    const out = join(work, "bundle");
    writeInstalled(out, old.files);

    const next = await scenario({ "air.json": "{ not json", "README.md": "# new\n" });
    expect(codes(await install(out, next.files, next.receipt))).toContain(
      "gateway_receipt/output_air_unreadable",
    );
  });

  it("refuses an existing directory with no receipt view, and deletes nothing", async () => {
    const { receipt, files } = await scenario(bundleFiles());
    const out = join(work, "bundle");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "hand-written.txt"), "not ours\n", "utf8");

    expect(codes(await install(out, files, receipt))).toEqual(["gateway_receipt/unmanaged_output"]);
    // The whole point of the refusal: an unaccounted-for file survives it.
    expect(existsSync(join(out, "hand-written.txt"))).toBe(true);
  });

  it("refuses to replace an output belonging to a different gateway identity", async () => {
    const old = await scenario(bundleFiles());
    const out = join(work, "bundle");
    writeInstalled(out, old.files);

    // Same output path, a different API — a coordinate collision, not an update.
    const other = await scenario(bundleFiles(), "other-api");
    expect(codes(await install(out, other.files, other.receipt))).toEqual([
      "gateway_receipt/output_identity_collision",
    ]);
    expect(readFileSync(join(out, "README.md"), "utf8")).toBe("# acct\n");
  });

  it("refuses when the output path exists as a file", async () => {
    const { receipt, files } = await scenario(bundleFiles());
    const out = join(work, "bundle");
    writeFileSync(out, "i am a file\n", "utf8");

    expect(codes(await install(out, files, receipt))).toEqual([
      "gateway_receipt/output_not_directory",
    ]);
  });

  it("refuses an existing output whose view no private receipt backs", async () => {
    const old = await scenario(bundleFiles());
    const out = join(work, "bundle");
    writeInstalled(out, old.files);

    // Drop the private receipt. The view in the directory now claims a lineage
    // that nothing in this workspace can vouch for, so its files are not ours
    // to replace — even though the view itself is perfectly well-formed.
    rmSync(join(work, ".anvil", "imports"), { recursive: true, force: true });
    const emptyStore = new FileSystemGatewayImportReceiptStore(join(work, ".anvil", "imports"));
    const next = finalizeGatewayImportReceipt(draftFor(bundleFiles()));
    const result = await prepareBundleInstall(
      out,
      { files: withReceiptView(bundleFiles(), next) },
      next,
      emptyStore,
      work,
      false,
      {},
    );

    expect(codes(result)).toEqual(["gateway_receipt/untrusted_output"]);
    expect(existsSync(join(out, "air.json"))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The file-set comparison the refusals are built on                           */
/* -------------------------------------------------------------------------- */

describe("exactFileSetDiagnostics", () => {
  it("reports a recorded file that is absent", () => {
    const found = exactFileSetDiagnostics(["a.json"], ["a.json", "b.json"]);
    expect(found.map((d) => d.code)).toEqual(["gateway_receipt/output_missing"]);
    expect(found[0]?.path).toBe("b.json");
  });

  it("reports a file the manifest does not account for", () => {
    const found = exactFileSetDiagnostics(["a.json", "extra.json"], ["a.json"]);
    expect(found.map((d) => d.code)).toEqual(["gateway_receipt/output_added"]);
    expect(found[0]?.path).toBe("extra.json");
  });

  it("permits an explicitly allowed addition, and only that one", () => {
    const allowed = new Set(["certification.json"]);
    expect(exactFileSetDiagnostics(["a.json", "certification.json"], ["a.json"], allowed)).toEqual(
      [],
    );
    expect(
      exactFileSetDiagnostics(
        ["a.json", "certification.json", "other.json"],
        ["a.json"],
        allowed,
      ).map((d) => d.path),
    ).toEqual(["other.json"]);
  });

  it("is symmetric about nothing — missing and added are distinct outcomes", () => {
    const both = exactFileSetDiagnostics(["b.json"], ["a.json"]);
    expect(both.map((d) => d.code).sort()).toEqual([
      "gateway_receipt/output_added",
      "gateway_receipt/output_missing",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Derived state: lifecycle artifacts and stale lineage                        */
/* -------------------------------------------------------------------------- */

/**
 * After an import, later commands write derived state next to the bundle —
 * `certification.json`, `*.report.json`, target kits. `anvil approve` records
 * that the output has moved on from its receipt by marking the view's lineage
 * `stale` and pinning the exact staged state it approved.
 *
 * These are the paths that decide what a re-import may delete, so they get the
 * same treatment as the refusals above.
 */
function staleView(current: Record<string, string>, receipt: GatewayImportReceipt) {
  const view = redactGatewayImportReceipt(receipt, { workspaceRoot: work });
  // `current` is the exact staged state approval recorded — not the whole
  // directory. Paths in it that are neither deterministic compiler output nor
  // recognized lifecycle state are refused before their integrity is checked.
  const manifest = gatewayBundleManifest(current);
  return {
    ...view,
    lineage: {
      status: "stale" as const,
      reason: "approval staged derived state",
      currentOutputDigest: manifest.digest,
      currentOutputFiles: manifest.files,
    },
  };
}

function writeWithView(dir: string, files: Record<string, string>, view: unknown) {
  writeInstalled(dir, files);
  writeFileSync(join(dir, "import.receipt.json"), `${JSON.stringify(view, null, 2)}\n`, "utf8");
}

describe("prepareBundleInstall — derived state", () => {
  it("refuses to discard deliberately-changed output without --replace-derived", async () => {
    const old = await scenario(bundleFiles());
    const out = join(work, "bundle");
    const onDisk = { ...bundleFiles(), "certification.json": "{}\n" };
    writeWithView(out, onDisk, staleView({ "certification.json": "{}\n" }, old.receipt));

    const next = await scenario(bundleFiles());
    expect(codes(await install(out, next.files, next.receipt))).toEqual([
      "gateway_receipt/stale_output_requires_replace",
    ]);
    expect(existsSync(join(out, "certification.json"))).toBe(true);
  });

  it("refuses when the recorded stale state no longer matches what is on disk", async () => {
    const old = await scenario(bundleFiles());
    const out = join(work, "bundle");
    const onDisk = { ...bundleFiles(), "certification.json": "{}\n" };
    // The approval recorded only the lifecycle artifact, so the untrusted-path
    // check passes and the integrity check is the one under test.
    writeWithView(out, onDisk, staleView({ "certification.json": "{}\n" }, old.receipt));
    // Someone edited the approved state after its digest was recorded.
    writeFileSync(join(out, "certification.json"), '{"tampered":true}\n', "utf8");

    const next = await scenario(bundleFiles());
    expect(codes(await install(out, next.files, next.receipt, true))).toEqual([
      "gateway_receipt/stale_output_changed",
    ]);
  });

  it("refuses to delete a stale-manifest path that is neither compiler output nor lifecycle state", async () => {
    const old = await scenario(bundleFiles());
    const out = join(work, "bundle");
    // `notes.txt` is not deterministic compiler output and is not a recognized
    // lifecycle artifact, so even --replace-derived will not delete it.
    const onDisk = { ...bundleFiles(), "notes.txt": "hand written\n" };
    writeWithView(out, onDisk, staleView({ "notes.txt": "hand written\n" }, old.receipt));

    const next = await scenario(bundleFiles());
    const result = await install(out, next.files, next.receipt, true);
    expect(codes(result)).toEqual(["gateway_receipt/stale_manifest_untrusted_path"]);
    expect(existsSync(join(out, "notes.txt"))).toBe(true);
  });

  it("refuses when a lifecycle artifact collides with a compiler-owned candidate file", async () => {
    const old = await scenario(bundleFiles());
    const out = join(work, "bundle");
    const onDisk = { ...bundleFiles(), "certification.json": "{}\n" };
    writeInstalled(out, { ...onDisk, "import.receipt.json": old.files["import.receipt.json"]! });

    // The new bundle itself claims `certification.json`, so preserving the
    // existing lifecycle artifact would silently overwrite generated output.
    const next = await scenario({ ...bundleFiles(), "certification.json": "{}\n" });
    expect(codes(await install(out, next.files, next.receipt))).toEqual([
      "gateway_receipt/lifecycle_collision",
    ]);
  });

  it("refuses when the candidate AIR cannot validate the lifecycle artifacts it would keep", async () => {
    const old = await scenario(bundleFiles());
    const out = join(work, "bundle");
    const onDisk = { ...bundleFiles(), "certification.json": "{}\n" };
    writeInstalled(out, { ...onDisk, "import.receipt.json": old.files["import.receipt.json"]! });

    const next = await scenario({ "air.json": "{ not json", "README.md": "# acct\n" });
    expect(codes(await install(out, next.files, next.receipt))).toContain(
      "gateway_receipt/candidate_air_unreadable",
    );
  });

  it("refuses a staged bundle whose own receipt view will not parse", async () => {
    const { receipt } = await scenario(bundleFiles());
    const corrupt = { ...bundleFiles(), "import.receipt.json": "{ not a receipt view\n" };
    expect(codes(await install(join(work, "bundle"), corrupt, receipt))).toContain(
      "gateway_receipt/bundle_receipt_unparseable",
    );
    expect(existsSync(join(work, "bundle"))).toBe(false);
  });

  it("reports an install that throws part-way as a failure, not a success", async () => {
    const { receipt } = await scenario(bundleFiles());
    // `a` cannot be both a file and a directory; writeBundle throws mid-stage.
    const impossible = { a: "file\n", "a/b": "child\n" };
    const result = await install(join(work, "bundle"), impossible, receipt);
    expect(codes(result)).toEqual(["gateway_receipt/output_install_failed"]);
    expect(existsSync(join(work, "bundle"))).toBe(false);
  });
});
