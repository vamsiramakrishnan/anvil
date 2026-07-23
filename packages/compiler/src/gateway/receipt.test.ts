import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileSystemGatewayImportReceiptStore,
  finalizeGatewayImportReceipt,
  GatewayImportReceipt,
  type GatewayImportReceiptDraft,
  GatewayImportReceiptView,
  gatewayBundleManifest,
  gatewaySha256,
  redactGatewayImportReceipt,
} from "./receipt.js";

const ARCHIVE_BYTES = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10, 0x00, 0x7f, 0x42]);

function draft(): GatewayImportReceiptDraft {
  return {
    schemaVersion: 1,
    receiptType: "anvil.gateway-import",
    selection: {
      vendor: "kong",
      apiId: "refunds",
      export: {
        format: "zip",
        sha256: gatewaySha256(ARCHIVE_BYTES),
        bytes: ARCHIVE_BYTES.byteLength,
        storedAs: "raw/export.bin",
      },
      archiveEntry: "kong/kong.yaml",
    },
    inventory: { digest: "inventory-digest" },
    contract: {
      provenance: {
        kind: "synthesized",
        fidelity: "route_only",
        format: "openapi",
        version: "3.0.3",
        location: {
          origin: "/private/customer/export.zip!kong/kong.yaml",
          pointer: "/services/0",
        },
        source: {
          snapshotId: "src-route-only",
          sourceHash: "sha256:route-only",
          entrypoint: "refunds.openapi.yaml",
        },
      },
      compilerSource: {
        snapshotId: "src-route-only",
        sourceHash: "sha256:route-only",
        entrypoint: "refunds.openapi.yaml",
      },
    },
    overlays: [
      {
        role: "gateway_policy",
        id: "overlay_gateway",
        digest: "overlay-digest",
        evidence: [
          {
            id: "gw-ev-1",
            kind: "source_impl",
            ref: "/private/customer/export.zip!kong/kong.yaml#/services/0/plugins/0",
          },
        ],
      },
    ],
    diagnostics: [
      {
        level: "warning",
        code: "gateway/route_only_contract",
        message: "Only routes were available.",
        coordinate: {
          origin: "/private/customer/export.zip!kong/kong.yaml",
          pointer: "/services/0",
        },
      },
    ],
    blockers: [
      {
        level: "warning",
        code: "gateway/route_only_contract",
        message: "Only routes were available.",
        coordinate: {
          origin: "/private/customer/export.zip!kong/kong.yaml",
          pointer: "/services/0",
        },
      },
    ],
    output: gatewayBundleManifest({
      "air.json": '{"service":{"id":"refunds"}}\n',
      "air.yaml": "service:\n  id: refunds\n",
    }),
  };
}

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-gateway-receipt-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("GatewayImportReceipt", () => {
  it("is deterministic and stores the original archive bytes without rewriting an idempotent hit", async () => {
    const firstReceipt = finalizeGatewayImportReceipt(draft());
    const secondReceipt = finalizeGatewayImportReceipt(draft());
    expect(secondReceipt).toEqual(firstReceipt);

    const store = new FileSystemGatewayImportReceiptStore(join(work, "imports"));
    const first = await store.create(firstReceipt, ARCHIVE_BYTES);
    expect(first).toMatchObject({ ok: true, created: true });
    if (!first.ok) return;
    const receiptPath = join(first.dir, "import.receipt.json");
    const rawPath = join(first.dir, "raw", "export.bin");
    const receiptStat = statSync(receiptPath);
    const rawStat = statSync(rawPath);
    expect(readFileSync(rawPath)).toEqual(Buffer.from(ARCHIVE_BYTES));

    const second = await store.create(secondReceipt, ARCHIVE_BYTES);
    expect(second).toMatchObject({ ok: true, created: false, dir: first.dir });
    expect(statSync(receiptPath).ino).toBe(receiptStat.ino);
    expect(statSync(receiptPath).mtimeMs).toBe(receiptStat.mtimeMs);
    expect(statSync(rawPath).ino).toBe(rawStat.ino);
    expect(statSync(rawPath).mtimeMs).toBe(rawStat.mtimeMs);
    await expect(store.verify(firstReceipt.importId)).resolves.toMatchObject({ ok: true });
  });

  it("detects tampering of either the immutable export or receipt", async () => {
    const receipt = finalizeGatewayImportReceipt(draft());
    const store = new FileSystemGatewayImportReceiptStore(join(work, "imports"));
    const created = await store.create(receipt, ARCHIVE_BYTES);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    writeFileSync(join(created.dir, "raw", "export.bin"), Uint8Array.from([1, 2, 3]));
    const rawTamper = await store.verify(receipt.importId);
    expect(rawTamper.ok).toBe(false);
    expect(rawTamper.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "gateway_receipt/export_changed",
    );

    writeFileSync(join(created.dir, "raw", "export.bin"), ARCHIVE_BYTES);
    const changed = JSON.parse(
      readFileSync(join(created.dir, "import.receipt.json"), "utf8"),
    ) as Record<string, unknown>;
    changed.inventory = { digest: "tampered" };
    writeFileSync(
      join(created.dir, "import.receipt.json"),
      `${JSON.stringify(changed, null, 2)}\n`,
    );
    const receiptTamper = await store.verify(receipt.importId);
    expect(receiptTamper.ok).toBe(false);
    expect(receiptTamper.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "gateway_receipt/digest_mismatch",
    );
  });

  it("emits an explicit redacted pointer view that cannot masquerade as a full receipt", () => {
    const receipt = finalizeGatewayImportReceipt(draft());
    const view = redactGatewayImportReceipt(receipt, {
      workspaceRoot: "/workspace/root with 'quote",
    });
    expect(GatewayImportReceiptView.parse(view)).toEqual(view);
    expect(GatewayImportReceipt.safeParse(view).success).toBe(false);
    expect(view).toMatchObject({
      viewType: "anvil.gateway-import-receipt-view",
      redacted: true,
      importId: receipt.importId,
      receiptDigest: receipt.digest,
      lineage: { status: "bound" },
      privateReceipt: {
        workspaceRoot: "$WORKSPACE",
        storedAs: `.anvil/imports/${receipt.importId}/import.receipt.json`,
        verifyCommand: `anvil estate verify ${receipt.importId} --root .`,
      },
    });
    expect(JSON.stringify(view)).not.toContain("/private/customer");
    expect(JSON.stringify(view)).not.toContain('"receiptType"');
  });
});
