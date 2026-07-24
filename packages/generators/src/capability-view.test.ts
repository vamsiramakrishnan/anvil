import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AirDocument, airFromYaml, airToYaml, hashCanonical } from "@anvil/air";
import { approveCapability, compile, type GatewayImportReceiptView } from "@anvil/compiler";
import { describe, expect, it } from "vitest";
import {
  CapabilityBuildError,
  type CapabilityBundleManifest,
  capabilityArtifactId,
  capabilityView,
  generateCapabilityBundle,
} from "./capability-view.js";

const read = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/payments/${rel}`, import.meta.url)),
    "utf8",
  );

/** Compile the payments example fresh (tests mutate lifecycle/state freely). */
async function paymentsAir(): Promise<AirDocument> {
  return compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
}

describe("capabilityView", () => {
  it("refuses a non-approved capability with a structured error", async () => {
    const air = await paymentsAir();
    expect(air.capabilities.find((c) => c.id === "payments.refunds")?.lifecycle).toBe("proposed");
    try {
      capabilityView(air, "payments.refunds");
      expect.unreachable();
    } catch (err) {
      const e = err as CapabilityBuildError;
      expect(e).toBeInstanceOf(CapabilityBuildError);
      expect(e.code).toBe("capability_not_approved");
      expect(e.message).toContain("anvil capability approve");
    }
  });

  it("refuses an unknown capability and a silently-empty build", async () => {
    const air = await paymentsAir();
    expect(() => capabilityView(air, "payments.nope")).toThrowError(/capability/i);
    try {
      capabilityView(air, "payments.nope");
    } catch (err) {
      expect((err as CapabilityBuildError).code).toBe("capability_not_found");
    }

    // Approve the grouping but un-approve every member operation: the build
    // must refuse rather than emit an empty-but-successful bundle.
    approveCapability(air, "payments.customers");
    for (const op of air.operations) {
      if (op.capabilityId === "payments.customers") op.state = "review_required";
    }
    try {
      capabilityView(air, "payments.customers");
      expect.unreachable();
    } catch (err) {
      expect((err as CapabilityBuildError).code).toBe("capability_empty");
    }
  });

  it("closes over approved workflow dependencies instead of silently dropping authored workflows", async () => {
    const air = await paymentsAir();
    approveCapability(air, "payments.refunds");
    const view = capabilityView(air, "payments.refunds");
    expect(view.operations.map((o) => o.id)).toEqual([
      "payments.payments.get",
      "payments.refunds.create",
    ]);
    expect(view.capabilities).toHaveLength(1);
    expect(view.capabilities[0]?.operationIds).toEqual([
      "payments.refunds.create",
      "payments.payments.get",
    ]);
    expect(view.workflows.map((workflow) => workflow.id)).toEqual([
      "payments.refunds.refund_customer",
    ]);
    expect(view.capabilities[0]?.workflowIds).toEqual(["payments.refunds.refund_customer"]);
    expect(view.service.id).toBe("payments-refunds");
    // Narrowing never mutates the source document.
    expect(air.operations.length).toBeGreaterThan(view.operations.length);
  });

  it("fails loudly when an authored workflow dependency is not approved", async () => {
    const air = await paymentsAir();
    approveCapability(air, "payments.refunds");
    const dependency = air.operations.find((op) => op.id === "payments.payments.get");
    if (dependency) dependency.state = "review_required";
    try {
      capabilityView(air, "payments.refunds");
      expect.unreachable();
    } catch (error) {
      expect((error as CapabilityBuildError).code).toBe(
        "capability_workflow_dependency_unapproved",
      );
      expect((error as Error).message).toContain("payments.payments.get");
    }
  });

  it("refuses a capability build when an audited workflow is blocked", async () => {
    const air = await paymentsAir();
    approveCapability(air, "payments.refunds");
    const workflow = air.workflows.find((candidate) => candidate.id.endsWith(".refund_customer"));
    if (!workflow) throw new Error("reference workflow missing");
    workflow.state = "blocked";
    try {
      capabilityView(air, "payments.refunds");
      expect.unreachable();
    } catch (error) {
      expect((error as CapabilityBuildError).code).toBe("capability_workflow_blocked");
      expect((error as Error).message).toContain(workflow.id);
    }
  });

  it("projects long capability ids to stable, service-safe artifact identities", () => {
    const id = `payments.${"very_long_capability_name_".repeat(4)}`;
    const projected = capabilityArtifactId(id);
    expect(projected.length).toBeLessThanOrEqual(64);
    expect(projected).toMatch(/^payments-[a-z0-9-]+$/);
    expect(capabilityArtifactId(id)).toBe(projected);
  });
});

describe("capability bundle (acceptance)", () => {
  it("exposes the same approved operations on the CLI, MCP, and skill surfaces", async () => {
    const air = await paymentsAir();
    approveCapability(air, "payments.payments");
    const { bundle, manifest, view } = generateCapabilityBundle(air, "payments.payments");
    const ids = view.operations.map((o) => o.id).sort();
    expect(ids).toEqual(["payments.capture.create", "payments.payments.get"]);

    // bundle.json: each surface lists exactly the approved member operations.
    expect(manifest.surfaces.cli.operations).toEqual(
      view.operations.map((o) => o.cli.command).sort(),
    );
    expect(manifest.surfaces.mcp.operations).toEqual(
      view.operations.map((o) => o.mcp.toolName).sort(),
    );
    expect(manifest.surfaces.skill.operations).toEqual(
      view.operations.map((o) => o.canonicalName).sort(),
    );

    // The emitted artifacts agree: runtime manifest (CLI/MCP execution path),
    // MCP model, and skill reference all expose the same operation set.
    const files = bundle.files;
    const runtime = JSON.parse(files["runtime/operations.manifest.json"] as string);
    expect(runtime.operations.map((o: { id: string }) => o.id).sort()).toEqual(ids);
    const mcpAir = JSON.parse(files["mcp/air.json"] as string);
    expect(
      mcpAir.operations
        .filter((o: { state: string }) => o.state === "approved")
        .map((o: { id: string }) => o.id)
        .sort(),
    ).toEqual(ids);
    const skillOps = files["skill/reference/operations.md"] as string;
    for (const op of view.operations) expect(skillOps).toContain(op.canonicalName);
    expect(files["bundle.json"]).toBeDefined();
  });

  it("never lets an unapproved operation reach ANY generated surface", async () => {
    const air = await paymentsAir();
    // Un-approve capture: it stays a member of payments.payments but must not ship.
    const capture = air.operations.find((o) => o.id === "payments.capture.create");
    expect(capture).toBeDefined();
    if (capture) capture.state = "review_required";
    approveCapability(air, "payments.payments");
    const { bundle, manifest } = generateCapabilityBundle(air, "payments.payments");

    // Grep every emitted artifact: neither the unapproved member (capture) nor
    // any operation of another capability (refund, customer) may appear under
    // any of its identities — AIR id, canonical name, MCP tool, or CLI command.
    const excluded = air.operations.filter((o) => o.id !== "payments.payments.get");
    expect(excluded.length).toBeGreaterThan(0);
    for (const [path, contents] of Object.entries(bundle.files)) {
      for (const op of excluded) {
        for (const token of [op.id, op.canonicalName, op.mcp.toolName, op.cli.command]) {
          expect(contents, `'${token}' leaked into ${path}`).not.toContain(token);
        }
      }
    }
    for (const surface of Object.values(manifest.surfaces)) {
      expect(surface.operations).toEqual(surface.operations.filter((name) => name.includes("get")));
    }
  });

  it("derives a capability deployment namespace from the parent estate namespace", async () => {
    const air = await paymentsAir();
    approveCapability(air, "payments.refunds");
    const prod = generateCapabilityBundle(air, "payments.refunds", {
      deploymentNamespace: "payments-prod-coordinate",
    });
    const test = generateCapabilityBundle(air, "payments.refunds", {
      deploymentNamespace: "payments-test-coordinate",
    });
    const prodMetadata = JSON.parse(prod.bundle.files["generation.json"] as string);
    const testMetadata = JSON.parse(test.bundle.files["generation.json"] as string);
    const prodNamespace = prodMetadata.resourceOptions.deploymentNamespace as string;
    const testNamespace = testMetadata.resourceOptions.deploymentNamespace as string;

    expect(prod.view.service.id).toBe("payments-refunds");
    expect(test.view.service.id).toBe(prod.view.service.id);
    expect(prodNamespace).toMatch(/^payments-prod-coordinate-[a-f0-9]{24}$/);
    expect(testNamespace).toMatch(/^payments-test-coordinate-[a-f0-9]{24}$/);
    expect(prodNamespace).not.toBe(testNamespace);
    expect(prod.bundle.files["deploy/terraform/main.tf"]).toContain(
      `firestore://\${var.project_id}/\${local.ledger_database_id}/${prodNamespace}`,
    );
  });

  it("shares one contract hash across surfaces and rebuilds reproducibly", async () => {
    const air = await paymentsAir();
    approveCapability(air, "payments.payments");
    // Round-trip through YAML — the on-disk path `anvil build` actually takes.
    const yaml = airToYaml(air);

    const first = generateCapabilityBundle(airFromYaml(yaml), "payments.payments");
    const second = generateCapabilityBundle(airFromYaml(yaml), "payments.payments");

    const m = first.manifest;
    expect(m.schemaVersion).toBe(1);
    expect(m.capabilityId).toBe("payments.payments");
    expect(m.artifactId).toBe("payments-payments");
    expect(m.parentServiceId).toBe("payments");
    expect(m.capabilityVersion).toBe(air.service.version);
    // One bundle hash, shared by every surface.
    expect(m.surfaces.cli.contractHash).toBe(m.contractHash);
    expect(m.surfaces.mcp.contractHash).toBe(m.contractHash);
    expect(m.surfaces.skill.contractHash).toBe(m.contractHash);

    // Rebuilding unchanged input reproduces the identical bundle, bit for bit.
    expect(second.manifest).toEqual(first.manifest);
    expect(second.bundle.files).toEqual(first.bundle.files);

    // A contract change (different approved set) changes the hash.
    const altered: CapabilityBundleManifest = (() => {
      const doc = airFromYaml(yaml);
      const get = doc.operations.find((o) => o.id === "payments.payments.get");
      if (get) get.state = "review_required";
      return generateCapabilityBundle(doc, "payments.payments").manifest;
    })();
    expect(altered.contractHash).not.toBe(m.contractHash);
  });

  it("binds a parent gateway receipt and preserves anonymous gateway blockers", async () => {
    const air = await paymentsAir();
    approveCapability(air, "payments.refunds");
    air.diagnostics.push({
      level: "warning",
      code: "gateway/opaque_policy",
      message: "An opaque policy still needs review.",
    });
    const sha = `sha256:${"a".repeat(64)}`;
    const receipt: GatewayImportReceiptView = {
      schemaVersion: 1,
      viewType: "anvil.gateway-import-receipt-view",
      redacted: true,
      importId: "gwi-0123456789abcdef",
      receiptDigest: sha,
      lineage: { status: "bound" },
      privateReceipt: {
        workspaceRoot: "$WORKSPACE",
        storedAs: ".anvil/imports/gwi-0123456789abcdef/import.receipt.json",
        verifyCommand: "anvil estate verify gwi-0123456789abcdef --root .",
      },
      selection: {
        vendor: "fixture",
        apiId: "payments",
        export: { format: "text", sha256: sha, bytes: 10 },
      },
      inventoryDigest: "inventory-digest",
      contract: {
        provenance: {
          kind: "native",
          fidelity: "full",
          format: "openapi",
          location: { origin: "fixture-export.yaml" },
        },
        compilerSource: {
          snapshotId: "src-1",
          sourceHash: sha,
          entrypoint: "openapi.yaml",
        },
      },
      overlays: [],
      diagnostics: [
        {
          level: "warning",
          code: "gateway/opaque_policy",
          message: "An opaque policy still needs review.",
        },
      ],
      blockers: [
        {
          level: "warning",
          code: "gateway/opaque_policy",
          message: "An opaque policy still needs review.",
        },
      ],
      output: { digest: sha, files: [] },
    };

    const built = generateCapabilityBundle(air, "payments.refunds", {
      parentGatewayReceipt: receipt,
    });
    expect(built.manifest.parentGatewayImport).toEqual({
      importId: receipt.importId,
      receiptDigest: receipt.receiptDigest,
      receiptViewDigest: hashCanonical(receipt),
      outputDigest: receipt.output.digest,
      lineage: "bound",
      blockerCount: 1,
    });
    expect(built.bundle.files["provenance/parent-gateway-import.receipt.json"]).toBe(
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    expect(built.view.diagnostics).toContainEqual(
      expect.objectContaining({ code: "gateway/opaque_policy" }),
    );
  });
});
