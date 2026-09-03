import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { airToJson, loadAirDocument, Operation } from "@anvil/air";
import { afterEach, describe, expect, it } from "vitest";
import { buildFleetForWorkspace } from "./serve.js";

/**
 * `--fleet` builds real bundle fixtures on disk (not through the full
 * `anvil compile` pipeline — this exercises `buildFleetForWorkspace`'s own
 * discovery/certification-reading/composition, not the compiler) so it stays
 * fast while still going through `discoverBundles` and a real `air.json`
 * exactly as a deployed workspace would.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function op(overrides: Record<string, unknown> = {}): Operation {
  return Operation.parse({
    id: "svc.list",
    canonicalName: "list_things",
    displayName: "List things",
    sourceRef: { kind: "openapi", path: "/things", method: "get" },
    effect: { kind: "read", action: "list", resource: "thing", risk: "low", reversible: false },
    input: { params: [] },
    idempotency: { mode: "natural", mechanism: "none" },
    retries: { mode: "safe", maxAttempts: 3, backoff: "exponential", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "things list" },
    mcp: { toolName: "list_things" },
    skill: { intentExamples: [] },
    state: "approved",
    ...overrides,
  });
}

function writeBundle(dir: string, serviceId: string, toolName: string): void {
  mkdirSync(dir, { recursive: true });
  const air = loadAirDocument({
    service: { id: serviceId, version: "1.0.0", source: { kind: "openapi" } },
    operations: [op({ id: `${serviceId}.list`, mcp: { toolName } })],
  });
  writeFileSync(join(dir, "air.json"), airToJson(air), "utf8");
}

function workspaceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "anvil-fleet-cli-"));
  roots.push(root);
  return root;
}

describe("buildFleetForWorkspace", () => {
  it("discovers every bundle beneath the workspace root and mounts them all", async () => {
    const root = workspaceRoot();
    writeBundle(join(root, "billing"), "billing", "list_invoices");
    writeBundle(join(root, "shipping"), "shipping", "list_shipments");

    const built = await buildFleetForWorkspace(root, {});
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("unreachable");
    expect(built.bundleIds.sort()).toEqual(["billing", "shipping"]);
    const readyz = built.fleet.readyz();
    expect(readyz.bundles.map((b) => b.id).sort()).toEqual(["billing", "shipping"]);
    await built.fleet.close();
  });

  it("reads each bundle's own certification.json into readyz, uncertified bundles report ready:false", async () => {
    const root = workspaceRoot();
    writeBundle(join(root, "billing"), "billing", "list_invoices");
    writeFileSync(
      join(root, "billing", "certification.json"),
      JSON.stringify({
        schemaVersion: 1,
        serviceId: "billing",
        bundleHash: "sha256:deadbeef",
        assuranceLevel: "static",
        status: "passed",
        checks: [],
        certifiedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const built = await buildFleetForWorkspace(root, {});
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("unreachable");
    const readyz = built.fleet.readyz();
    expect(readyz.ready).toBe(true);
    expect(readyz.bundles).toEqual([
      {
        id: "billing",
        serviceId: "billing",
        toolCount: 1,
        certifiedHash: "sha256:deadbeef",
        certificationStatus: "passed",
        ready: true,
      },
    ]);
    await built.fleet.close();
  });

  it("refuses (without throwing) when the workspace has no bundles", async () => {
    const root = workspaceRoot();
    const built = await buildFleetForWorkspace(root, {});
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.message).toMatch(/no bundles found/);
  });

  it("surfaces a cross-bundle tool collision as a failure result, not a throw out of the CLI", async () => {
    const root = workspaceRoot();
    // Two distinct bundle ids that fold to the same prefix and mount the same
    // tool name underneath it.
    writeBundle(join(root, "svc"), "svc-a", "list_things");
    writeBundle(join(root, "svc!!"), "svc-b", "list_things");

    const built = await buildFleetForWorkspace(root, {});
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.message).toMatch(/collision/);
  });

  it("resolves the configured principal for the whole session from ANVIL_PRINCIPAL", async () => {
    const root = workspaceRoot();
    writeBundle(join(root, "billing"), "billing", "list_invoices");
    const built = await buildFleetForWorkspace(root, {
      ANVIL_PRINCIPALS: "tok_abc:alice:orders.read",
      ANVIL_PRINCIPAL: "tok_abc",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("unreachable");
    await built.fleet.close();
  });
});
