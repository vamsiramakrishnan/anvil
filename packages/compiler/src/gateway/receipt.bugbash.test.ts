import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileSystemGatewayImportReceiptStore,
  finalizeGatewayImportReceipt,
  type GatewayImportReceipt,
  type GatewayImportReceiptDraft,
  gatewayBundleManifest,
  gatewayCapabilityReviewInput,
  gatewayImportReceiptDigest,
  gatewaySha256,
  isGatewayLifecycleArtifact,
  parseGatewayImportReceipt,
  redactGatewayImportReceipt,
  verifyGatewayImportOutput,
  verifyGatewayImportOutputManifest,
  verifyGatewayImportReceipt,
} from "./receipt.js";

const ARCHIVE_BYTES = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10, 0x00, 0x7f, 0x42]);

const FAKE_DIGEST_A = `sha256:${"a".repeat(64)}`;
const FAKE_DIGEST_B = `sha256:${"b".repeat(64)}`;

function baseDraft(): GatewayImportReceiptDraft {
  return {
    schemaVersion: 1,
    receiptType: "anvil.gateway-import",
    selection: {
      vendor: "kong",
      apiId: "test-api",
      export: {
        format: "zip",
        sha256: gatewaySha256(ARCHIVE_BYTES),
        bytes: ARCHIVE_BYTES.byteLength,
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
        location: {
          origin: "/export.zip",
          pointer: "/services/0",
        },
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
    output: gatewayBundleManifest({
      "air.json": '{"service":{"id":"test"}}',
    }),
  };
}

describe("isGatewayLifecycleArtifact", () => {
  it("identifies known lifecycle records", () => {
    expect(isGatewayLifecycleArtifact("certification.json")).toBe(true);
    expect(isGatewayLifecycleArtifact("publication.json")).toBe(true);
    expect(isGatewayLifecycleArtifact("selftest.report.json")).toBe(true);
    expect(isGatewayLifecycleArtifact("conformance.report.json")).toBe(true);
    expect(isGatewayLifecycleArtifact("conformance.live.report.json")).toBe(true);
    expect(isGatewayLifecycleArtifact("simulation.report.json")).toBe(true);
  });

  it("identifies custom report.json files at root", () => {
    expect(isGatewayLifecycleArtifact("custom.report.json")).toBe(true);
    expect(isGatewayLifecycleArtifact("foo-bar.report.json")).toBe(true);
  });

  it("rejects paths with directory separators", () => {
    expect(isGatewayLifecycleArtifact("subdir/certification.json")).toBe(false);
    expect(isGatewayLifecycleArtifact("any/path/custom.report.json")).toBe(false);
  });

  it("rejects non-lifecycle files", () => {
    expect(isGatewayLifecycleArtifact("air.json")).toBe(false);
    expect(isGatewayLifecycleArtifact("report.txt")).toBe(false);
    expect(isGatewayLifecycleArtifact("certification")).toBe(false);
  });
});

describe("gatewaySha256", () => {
  it("produces sha256 digest with prefix", () => {
    const result = gatewaySha256(ARCHIVE_BYTES);
    expect(result).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const first = gatewaySha256(ARCHIVE_BYTES);
    const second = gatewaySha256(ARCHIVE_BYTES);
    expect(first).toBe(second);
  });

  it("differs for different inputs", () => {
    const first = gatewaySha256(ARCHIVE_BYTES);
    const second = gatewaySha256(Uint8Array.from([1, 2, 3]));
    expect(first).not.toBe(second);
  });
});

describe("gatewayCapabilityReviewInput", () => {
  it("returns undefined for empty reviews", () => {
    expect(gatewayCapabilityReviewInput({})).toBeUndefined();
  });

  it("canonicalizes review decisions", () => {
    const result = gatewayCapabilityReviewInput({
      "cap-b": { state: "approved" },
      "cap-a": { state: "rejected" },
    });
    expect(result?.decisions).toEqual([
      { capabilityId: "cap-a", state: "rejected", allowLarge: false },
      { capabilityId: "cap-b", state: "approved", allowLarge: false },
    ]);
  });

  it("includes optional note field", () => {
    const result = gatewayCapabilityReviewInput({
      "cap-1": { state: "approved", note: "reviewed" },
    });
    expect(result?.decisions[0]).toHaveProperty("note", "reviewed");
  });

  it("handles allow_large flag", () => {
    const result = gatewayCapabilityReviewInput({
      "cap-1": { state: "approved", allow_large: true },
    });
    expect(result?.decisions[0]?.allowLarge).toBe(true);
  });

  it("produces canonical digest", () => {
    const first = gatewayCapabilityReviewInput({
      b: { state: "approved" },
      a: { state: "rejected" },
    });
    const second = gatewayCapabilityReviewInput({
      a: { state: "rejected" },
      b: { state: "approved" },
    });
    expect(first?.digest).toBe(second?.digest);
  });
});

describe("gatewayBundleManifest", () => {
  it("excludes import.receipt.json", () => {
    const result = gatewayBundleManifest({
      "air.json": "{}",
      "import.receipt.json": '{"should":"exclude"}',
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe("air.json");
  });

  it("sorts files by path", () => {
    const result = gatewayBundleManifest({
      "z.json": "z",
      "a.json": "a",
      "m.json": "m",
    });
    expect(result.files.map((f) => f.path)).toEqual(["a.json", "m.json", "z.json"]);
  });

  it("computes sha256 for each file", () => {
    const result = gatewayBundleManifest({
      "test.json": "content",
    });
    expect(result.files[0]?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("computes byte length", () => {
    const content = "test content";
    const result = gatewayBundleManifest({
      "test.json": content,
    });
    expect(result.files[0]?.bytes).toBe(new TextEncoder().encode(content).byteLength);
  });

  it("produces canonical digest", () => {
    const first = gatewayBundleManifest({
      "z.json": "z",
      "a.json": "a",
    });
    const second = gatewayBundleManifest({
      "a.json": "a",
      "z.json": "z",
    });
    expect(first.digest).toBe(second.digest);
  });
});

describe("parseGatewayImportReceipt", () => {
  it("returns diagnostics for invalid JSON", () => {
    const result = parseGatewayImportReceipt("not json");
    expect(result.receipt).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("gateway_receipt/unparseable");
    expect(result.diagnostics[0]?.message).toContain("not valid JSON");
  });

  it("returns diagnostics for schema validation failure", () => {
    const result = parseGatewayImportReceipt('{"schemaVersion":1}');
    expect(result.receipt).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("gateway_receipt/invalid");
  });

  it("parses valid receipt", () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const text = JSON.stringify(receipt);
    const result = parseGatewayImportReceipt(text);
    expect(result.receipt).toEqual(receipt);
    expect(result.diagnostics).toHaveLength(0);
  });
});

describe("verifyGatewayImportReceipt", () => {
  it("accepts valid receipt", () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const result = verifyGatewayImportReceipt(receipt, ARCHIVE_BYTES);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("detects digest mismatch", () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const tampered = {
      ...receipt,
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    };
    const result = verifyGatewayImportReceipt(tampered);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/digest_mismatch");
  });

  it("detects importId mismatch", () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const tampered = { ...receipt, importId: "gwi-0000000000000000" };
    const result = verifyGatewayImportReceipt(tampered);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/id_mismatch");
  });

  it("detects output manifest digest mismatch", () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const tampered = {
      ...receipt,
      output: {
        ...receipt.output,
        digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      },
    };
    const result = verifyGatewayImportReceipt(tampered);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/output_manifest_mismatch");
  });

  it("verifies export bytes hash when provided", () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const badBytes = Uint8Array.from([1, 2, 3]);
    const result = verifyGatewayImportReceipt(receipt, badBytes);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/export_changed");
  });

  it("verifies export bytes length when provided", () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const truncated = ARCHIVE_BYTES.slice(0, 1);
    const result = verifyGatewayImportReceipt(receipt, truncated);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/export_size_changed");
  });

  it("detects contract source provenance mismatch", () => {
    const draft = baseDraft();
    draft.contract.provenance = {
      ...draft.contract.provenance,
      source: {
        snapshotId: "different",
        sourceHash: "sha256:different",
        entrypoint: "different.yaml",
      },
    };
    const receipt = finalizeGatewayImportReceipt(draft);
    const result = verifyGatewayImportReceipt(receipt);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/contract_source_mismatch");
  });

  it("detects locked source mismatch with compiler source", () => {
    const draft = baseDraft();
    draft.lockedSource = {
      schemaVersion: 1,
      snapshotId: "different",
      sourceHash: "sha256:different",
      status: "valid",
      entrypoints: [{ path: "api.yaml", format: "openapi", version: "3.0.3" }],
      files: [{ path: "api.yaml", sha256: FAKE_DIGEST_A, bytes: 3, role: "entrypoint" }],
      diagnostics: [],
    };
    const receipt = finalizeGatewayImportReceipt(draft);
    const result = verifyGatewayImportReceipt(receipt);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/locked_source_mismatch");
  });

  it("detects locked source file manifest mismatch", () => {
    const draft = baseDraft();
    draft.lockedSource = {
      schemaVersion: 1,
      snapshotId: draft.contract.compilerSource.snapshotId,
      sourceHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      status: "valid",
      entrypoints: [{ path: "api.yaml", format: "openapi", version: "3.0.3" }],
      files: [{ path: "api.yaml", sha256: "abc123", bytes: 3, role: "entrypoint" }],
      diagnostics: [],
    };
    const receipt = finalizeGatewayImportReceipt(draft);
    const result = verifyGatewayImportReceipt(receipt);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/locked_source_manifest_mismatch");
  });

  it("detects locked source missing entrypoint", () => {
    const draft = baseDraft();
    draft.lockedSource = {
      schemaVersion: 1,
      snapshotId: draft.contract.compilerSource.snapshotId,
      sourceHash: draft.contract.compilerSource.sourceHash,
      status: "valid",
      entrypoints: [{ path: "other.yaml", format: "openapi", version: "3.0.3" }],
      files: [{ path: "other.yaml", sha256: "abc123", bytes: 3, role: "entrypoint" }],
      diagnostics: [],
    };
    const receipt = finalizeGatewayImportReceipt(draft);
    const result = verifyGatewayImportReceipt(receipt);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/locked_source_entrypoint_mismatch");
  });

  it("detects capability review ordering issue", () => {
    const draft = baseDraft();
    const reviews = gatewayCapabilityReviewInput({
      "z-cap": { state: "approved" },
      "a-cap": { state: "rejected" },
    });
    if (reviews) {
      draft.compilerInput = {
        capabilityReviews: {
          ...reviews,
          decisions: [...reviews.decisions].reverse(),
        },
      };
    }
    const receipt = finalizeGatewayImportReceipt(draft);
    const result = verifyGatewayImportReceipt(receipt);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/capability_review_not_canonical");
  });

  it("detects capability review digest mismatch", () => {
    const draft = baseDraft();
    const reviews = gatewayCapabilityReviewInput({
      cap: { state: "approved" },
    });
    if (reviews) {
      draft.compilerInput = {
        capabilityReviews: {
          ...reviews,
          digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        },
      };
    }
    const receipt = finalizeGatewayImportReceipt(draft);
    const result = verifyGatewayImportReceipt(receipt);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/capability_review_digest_mismatch");
  });

  it("detects formal definition lineage with non-wso2 vendor", () => {
    const draft = baseDraft();
    draft.selection.vendor = "kong";
    draft.contract.formalDefinitionLineage = {
      mode: "embedded_digest_match",
      candidates: [
        {
          role: "formal_definition",
          kind: "container",
          origin: "/origin/path",
          path: "path",
          digest: FAKE_DIGEST_A,
          bytes: 10,
        },
      ],
      supplied: {
        path: "api.yaml",
        digest: FAKE_DIGEST_A,
      },
    };
    const receipt = finalizeGatewayImportReceipt(draft);
    const result = verifyGatewayImportReceipt(receipt);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/formal_definition_vendor_mismatch");
  });

  it("detects formal definition candidates mismatch", () => {
    const draft = baseDraft();
    draft.selection.vendor = "wso2";
    const selectedArtifact = {
      role: "formal_definition" as const,
      kind: "container" as const,
      origin: "/origin/path",
      path: "path",
      digest: FAKE_DIGEST_B,
      bytes: 10,
    };
    draft.selection.artifacts = [selectedArtifact];
    draft.contract.formalDefinitionLineage = {
      mode: "embedded_digest_match",
      candidates: [
        {
          ...selectedArtifact,
          digest: FAKE_DIGEST_A,
        },
      ],
      supplied: {
        path: "api.yaml",
        digest: FAKE_DIGEST_A,
      },
    };
    const receipt = finalizeGatewayImportReceipt(draft);
    const result = verifyGatewayImportReceipt(receipt);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/formal_definition_candidates_mismatch");
  });

  it("detects formal definition source missing from locked source", () => {
    const draft = baseDraft();
    draft.selection.vendor = "wso2";
    draft.contract.formalDefinitionLineage = {
      mode: "embedded_digest_match",
      candidates: [
        {
          role: "formal_definition",
          kind: "container",
          origin: "/origin/path",
          path: "path",
          digest: FAKE_DIGEST_A,
          bytes: 10,
        },
      ],
      supplied: {
        path: "api.yaml",
        digest: FAKE_DIGEST_A,
      },
    };
    draft.lockedSource = {
      schemaVersion: 1,
      snapshotId: draft.contract.compilerSource.snapshotId,
      sourceHash: draft.contract.compilerSource.sourceHash,
      status: "valid",
      entrypoints: [{ path: "api.yaml", format: "openapi", version: "3.0.3" }],
      files: [{ path: "other.yaml", sha256: "sha256:other", bytes: 3, role: "entrypoint" }],
      diagnostics: [],
    };
    const receipt = finalizeGatewayImportReceipt(draft);
    const result = verifyGatewayImportReceipt(receipt);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/formal_definition_source_missing");
  });
});

describe("verifyGatewayImportOutput / verifyGatewayImportOutputManifest", () => {
  it("detects missing output file", () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const files = new Map<string, Uint8Array>();
    const result = verifyGatewayImportOutput(receipt, files);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/output_missing");
  });

  it("detects changed output file", () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const files = new Map<string, Uint8Array>();
    for (const file of receipt.output.files) {
      files.set(file.path, Uint8Array.from([1, 2, 3]));
    }
    const result = verifyGatewayImportOutput(receipt, files);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/output_changed");
  });

  it("accepts matching output files", () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const files = new Map<string, Uint8Array>();
    for (const file of receipt.output.files) {
      const content = file.path === "air.json" ? '{"service":{"id":"test"}}' : "content";
      files.set(file.path, new TextEncoder().encode(content));
    }
    const result = verifyGatewayImportOutput(receipt, files);
    expect(result.ok).toBe(true);
  });

  it("detects output digest mismatch when all files present but recomputed digest differs", () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const tampered = {
      ...receipt,
      output: {
        ...receipt.output,
        digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      },
    };
    const files = new Map<string, Uint8Array>();
    for (const file of receipt.output.files) {
      const content = file.path === "air.json" ? '{"service":{"id":"test"}}' : "content";
      files.set(file.path, new TextEncoder().encode(content));
    }
    const result = verifyGatewayImportOutputManifest(tampered.output, files);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/output_digest_mismatch");
  });
});

describe("redactGatewayImportReceipt", () => {
  it("redacts receipt to view format", () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const view = redactGatewayImportReceipt(receipt);
    expect(view).toMatchObject({
      schemaVersion: 1,
      viewType: "anvil.gateway-import-receipt-view",
      redacted: true,
    });
  });

  it("removes receiptType and other private fields from view", () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const view = redactGatewayImportReceipt(receipt);
    expect(view).not.toHaveProperty("receiptType");
    expect(JSON.stringify(view)).not.toContain("receiptType");
  });

  it("redacts origin coordinates in artifacts", () => {
    const draft = baseDraft();
    draft.selection.artifacts = [
      {
        role: "formal_definition",
        kind: "container",
        origin: "/private/path/to/file!member",
        path: "some/path",
        digest: FAKE_DIGEST_A,
        bytes: 10,
      },
    ];
    const receipt = finalizeGatewayImportReceipt(draft);
    const view = redactGatewayImportReceipt(receipt);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("/private/path/to");
  });

  it("includes lineage status in view", () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const view = redactGatewayImportReceipt(receipt);
    expect(view.lineage).toEqual({ status: "bound" });
  });

  it("includes workspace-redacted privateReceipt path", () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const view = redactGatewayImportReceipt(receipt);
    expect(view.privateReceipt.workspaceRoot).toBe("$WORKSPACE");
    expect(view.privateReceipt.storedAs).toContain(receipt.importId);
  });

  it("redacts capability review notes to digest", () => {
    const draft = baseDraft();
    const reviews = gatewayCapabilityReviewInput({
      cap: { state: "approved", note: "sensitive note" },
    });
    if (reviews) {
      draft.compilerInput = { capabilityReviews: reviews };
    }
    const receipt = finalizeGatewayImportReceipt(draft);
    const view = redactGatewayImportReceipt(receipt);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("sensitive note");
    if (view.compilerInput?.capabilityReviews) {
      expect(view.compilerInput.capabilityReviews.decisions[0]).toHaveProperty("noteDigest");
    }
  });

  it("handles missing optional fields in redaction", () => {
    const draft = baseDraft();
    draft.runtime = {
      gatewayUrl: "https://gateway.example.com",
      attestation: "operator",
    };
    const receipt = finalizeGatewayImportReceipt(draft);
    const view = redactGatewayImportReceipt(receipt);
    expect(view.runtime).toBeDefined();
  });
});

describe("FileSystemGatewayImportReceiptStore", () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "anvil-bugbash-"));
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("rejects invalid import id on load", async () => {
    const store = new FileSystemGatewayImportReceiptStore(work);
    const result = await store.load("not-a-valid-id");
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/invalid_id");
  });

  it("returns not found for missing receipt", async () => {
    const store = new FileSystemGatewayImportReceiptStore(work);
    const result = await store.load("gwi-0000000000000000");
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/not_found");
  });

  it("loads existing receipt", async () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const store = new FileSystemGatewayImportReceiptStore(work);
    const created = await store.create(receipt, ARCHIVE_BYTES);
    if (!created.ok) throw new Error("create failed");

    const loaded = await store.load(receipt.importId);
    expect(loaded.ok).toBe(true);
    expect(loaded.receipt).toEqual(receipt);
  });

  it("returns error on corrupted receipt JSON", async () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const store = new FileSystemGatewayImportReceiptStore(work);
    const created = await store.create(receipt, ARCHIVE_BYTES);
    if (!created.ok) throw new Error("create failed");

    writeFileSync(join(created.dir, "import.receipt.json"), "not json");
    const loaded = await store.load(receipt.importId);
    expect(loaded.ok).toBe(false);
    const codes = loaded.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/unparseable");
  });

  it("detects missing raw export on verify", async () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const store = new FileSystemGatewayImportReceiptStore(work);
    const created = await store.create(receipt, ARCHIVE_BYTES);
    if (!created.ok) throw new Error("create failed");

    rmSync(join(created.dir, "raw", "export.bin"));
    const verified = await store.verify(receipt.importId);
    expect(verified.ok).toBe(false);
    const codes = verified.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/export_missing");
  });

  it("detects unexpected files in import directory", async () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const store = new FileSystemGatewayImportReceiptStore(work);
    const created = await store.create(receipt, ARCHIVE_BYTES);
    if (!created.ok) throw new Error("create failed");

    writeFileSync(join(created.dir, "unexpected.json"), "{}");
    const verified = await store.verify(receipt.importId);
    expect(verified.ok).toBe(false);
    const codes = verified.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/unexpected_file");
  });

  it("detects unexpected files in raw directory", async () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const store = new FileSystemGatewayImportReceiptStore(work);
    const created = await store.create(receipt, ARCHIVE_BYTES);
    if (!created.ok) throw new Error("create failed");

    writeFileSync(join(created.dir, "raw", "extra.bin"), "");
    const verified = await store.verify(receipt.importId);
    expect(verified.ok).toBe(false);
    const codes = verified.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/unexpected_file");
  });

  it("detects directory/receipt id mismatch", async () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const store = new FileSystemGatewayImportReceiptStore(work);
    const created = await store.create(receipt, ARCHIVE_BYTES);
    if (!created.ok) throw new Error("create failed");

    const changed = JSON.parse(
      readFileSync(join(created.dir, "import.receipt.json"), "utf8"),
    ) as Record<string, unknown>;
    changed.importId = "gwi-9999999999999999";
    writeFileSync(join(created.dir, "import.receipt.json"), JSON.stringify(changed));

    const verified = await store.verify(receipt.importId);
    expect(verified.ok).toBe(false);
    const codes = verified.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/directory_mismatch");
  });

  it("rejects collision on existing invalid receipt", async () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const store = new FileSystemGatewayImportReceiptStore(work);
    const created = await store.create(receipt, ARCHIVE_BYTES);
    if (!created.ok) throw new Error("create failed");

    writeFileSync(join(created.dir, "import.receipt.json"), "corrupted");
    const second = await store.create(receipt, ARCHIVE_BYTES);
    expect(second.ok).toBe(false);
    const codes = second.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/id_collision");
  });

  it("creates receipt directory with correct permissions", async () => {
    const receipt = finalizeGatewayImportReceipt(baseDraft());
    const store = new FileSystemGatewayImportReceiptStore(work);
    const created = await store.create(receipt, ARCHIVE_BYTES);
    expect(created.ok).toBe(true);
  });

  it("returns error on verification failure during create", async () => {
    const draft = baseDraft();
    const receipt = finalizeGatewayImportReceipt(draft);
    const tampered = {
      ...receipt,
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    };
    const store = new FileSystemGatewayImportReceiptStore(work);
    const result = await store.create(tampered, ARCHIVE_BYTES);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("gateway_receipt/digest_mismatch");
  });
});

describe("receipt digest determinism", () => {
  it("produces same digest for same content", () => {
    const draft = baseDraft();
    const first = gatewayImportReceiptDigest(draft);
    const second = gatewayImportReceiptDigest(draft);
    expect(first).toBe(second);
  });

  it("produces different digest for different content", () => {
    const draft1 = baseDraft();
    const draft2 = baseDraft();
    draft2.selection.apiId = "different-api";
    expect(gatewayImportReceiptDigest(draft1)).not.toBe(gatewayImportReceiptDigest(draft2));
  });

  it("digest format matches gwi- prefix requirement", () => {
    const draft = baseDraft();
    const receipt = finalizeGatewayImportReceipt(draft);
    expect(receipt.importId).toMatch(/^gwi-[0-9a-f]{16}$/);
  });
});

describe("receipt with identity", () => {
  it("preserves identity in receipt", () => {
    const draft = baseDraft();
    draft.selection.identity = {
      vendor: "kong",
      gatewayId: "gw-123",
      apiId: "test-api",
      serviceId: "svc-1",
      environment: "prod",
      revision: "1.0",
      gatewayIdSource: "export",
      exportDigest: FAKE_DIGEST_A,
      inventoryDigest: "inv-123",
      digest: FAKE_DIGEST_B,
      lineageDigest: `sha256:${"c".repeat(64)}`,
    };
    const receipt = finalizeGatewayImportReceipt(draft);
    expect(receipt.selection.identity).toEqual(draft.selection.identity);
  });
});

describe("receipt with formal definition lineage", () => {
  it("accepts embedded_digest_match mode", () => {
    const draft = baseDraft();
    draft.contract.formalDefinitionLineage = {
      mode: "embedded_digest_match",
      candidates: [
        {
          role: "formal_definition",
          kind: "container",
          origin: "/origin/path",
          path: "path",
          digest: FAKE_DIGEST_A,
          bytes: 10,
        },
      ],
      supplied: {
        path: "api.yaml",
        digest: FAKE_DIGEST_A,
      },
    };
    const receipt = finalizeGatewayImportReceipt(draft);
    expect(receipt.contract.formalDefinitionLineage?.mode).toBe("embedded_digest_match");
  });

  it("accepts operator_override mode with reason", () => {
    const draft = baseDraft();
    draft.contract.formalDefinitionLineage = {
      mode: "operator_override",
      candidates: [
        {
          role: "formal_definition",
          kind: "container",
          origin: "/origin/path",
          path: "path",
          digest: FAKE_DIGEST_B,
          bytes: 10,
        },
      ],
      supplied: {
        path: "api.yaml",
        digest: FAKE_DIGEST_A,
      },
      override: {
        attestation: "operator",
        reason: "manual override justification",
      },
    };
    const receipt = finalizeGatewayImportReceipt(draft);
    expect(receipt.contract.formalDefinitionLineage?.override?.attestation).toBe("operator");
  });
});

describe("receipt with runtime coordinate", () => {
  it("includes runtime when provided", () => {
    const draft = baseDraft();
    draft.runtime = {
      gatewayUrl: "https://api.example.com",
      attestation: "operator",
    };
    const receipt = finalizeGatewayImportReceipt(draft);
    expect(receipt.runtime).toEqual(draft.runtime);
  });

  it("excludes runtime when not provided", () => {
    const draft = baseDraft();
    const receipt = finalizeGatewayImportReceipt(draft);
    expect(receipt.runtime).toBeUndefined();
  });
});

describe("receipt with archive entry", () => {
  it("includes archive entry when specified", () => {
    const draft = baseDraft();
    draft.selection.archiveEntry = "kong/kong.yaml";
    const receipt = finalizeGatewayImportReceipt(draft);
    expect(receipt.selection.archiveEntry).toBe("kong/kong.yaml");
  });
});
