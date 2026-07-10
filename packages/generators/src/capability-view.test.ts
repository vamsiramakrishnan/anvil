import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AirDocument, airFromYaml, airToYaml } from "@anvil/air";
import { approveCapability, compile } from "@anvil/compiler";
import { describe, expect, it } from "vitest";
import {
  CapabilityBuildError,
  type CapabilityBundleManifest,
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

  it("narrows to the capability's approved operations, workflows, and reachable schemas", async () => {
    const air = await paymentsAir();
    approveCapability(air, "payments.refunds");
    const view = capabilityView(air, "payments.refunds");
    expect(view.operations.map((o) => o.id)).toEqual(["payments.refunds.create"]);
    expect(view.capabilities).toHaveLength(1);
    expect(view.capabilities[0]?.operationIds).toEqual(["payments.refunds.create"]);
    // The authored refunds workflow steps through getPayment, which is not a
    // member of this capability's view — a workflow with an unexposed step
    // must not ship.
    expect(view.workflows).toEqual([]);
    expect(view.capabilities[0]?.workflowIds).toEqual([]);
    // Narrowing never mutates the source document.
    expect(air.operations.length).toBeGreaterThan(view.operations.length);
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
});
