import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { airFromYaml, airToYaml } from "@anvil/air";
import { compile, surfaceSignatureFor } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";
import type { StatusReport } from "./status.js";
import { buildStatusReport, renderStatusReport, runStatus } from "./status.js";

/**
 * `anvil status` — targeted coverage for state-rendering branches that
 * packages/cli/src/cmd-status.test.ts and certify-publish.test.ts do not
 * already exercise: a fully missing/corrupt canonical AIR, individual
 * projection drift, certification/publication record corruption, source
 * root-resolution edge cases, gateway-import receipt-view states beyond
 * "bound", non-gemini-enterprise target setup drift, operation-count/
 * nextAction ordering, and renderStatusReport formatting branches that never
 * occur on a real compiled bundle.
 */

const examples = fileURLToPath(new URL("../../../../examples/payments/", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

const dirs: string[] = [];
function freshDir(prefix = "anvil-bugbash-status-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A compiled payments bundle with no locked source (compile() from raw text never attaches one). */
async function paymentsBundle(): Promise<string> {
  const air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
  const dir = freshDir();
  writeBundle(dir, generateBundle(air));
  return dir;
}

function kongConfig(serviceName: string, path: string): string {
  return `_format_version: "3.0"
services:
  - name: ${serviceName}
    url: https://backend.internal/${serviceName}
    routes:
      - name: ${serviceName}-route
        paths: ["${path}"]
        methods: ["GET"]
`;
}

/** A bundle imported through `anvil estate import`, so import.receipt.json is a real bound receipt view. */
async function importedGatewayBundle(): Promise<{ bundle: string; root: string }> {
  const root = freshDir();
  const gateway = join(root, "kong.yaml");
  writeFileSync(gateway, kongConfig("refunds", "/refunds"));
  const bundle = join(root, "bundle");
  const io = bufferIO();
  const code = await runAnvilCli(
    ["estate", "import", gateway, "--vendor", "kong", "--out", bundle, "--root", root],
    { io },
  );
  expect(code, io.text()).toBe(0);
  return { bundle, root };
}

describe("buildStatusReport — missing and corrupt canonical AIR", () => {
  it("reports a fully missing canonical AIR for an empty bundle directory", async () => {
    const dir = freshDir();
    const report = await buildStatusReport(dir);
    expect(report.paths.canonicalAir).toBeNull();
    expect(report.serviceId).toBeNull();
    expect(report.source).toBeNull();
    expect(report.operations).toBeNull();
    expect(report.idempotency).toBeNull();
    expect(report.gatewayImport).toBeNull();
    expect(report.core.state).toBe("misaligned");
    expect(report.core.projections[0]).toMatchObject({
      id: "canonical",
      state: "missing",
      detail: expect.stringContaining("No air.yaml or air.json"),
    });
    expect(
      report.core.projections.slice(1).every((projection) => projection.state === "unverifiable"),
    ).toBe(true);
    expect(report.certification.state).toBe("missing");
    expect(report.nextAction).toMatchObject({
      code: "repair-core",
      command: "anvil compile --help",
    });
  });

  it("throws a plain error (not a StatusReport) for a bundle path that does not exist", async () => {
    const missing = join(freshDir(), "does-not-exist");
    await expect(buildStatusReport(missing)).rejects.toThrow(`No such bundle: ${missing}`);
  });

  it("marks canonical corrupt (not missing) when air.yaml exists but fails to parse", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "air.yaml"), "service: [this is not a valid AIR document\n");
    const report = await buildStatusReport(dir);
    expect(report.paths.canonicalAir).toBe(join(dir, "air.yaml"));
    expect(report.core.projections[0]).toMatchObject({
      id: "canonical",
      state: "corrupt",
      detail: expect.stringContaining("Canonical AIR is corrupt:"),
    });
    expect(report.nextAction).toMatchObject({
      code: "repair-core",
      command: "anvil compile --help",
    });
  });

  it("marks canonical corrupt for an air.json that is syntactically invalid JSON", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "air.json"), "{not valid json");
    const report = await buildStatusReport(dir);
    expect(report.paths.canonicalAir).toBe(join(dir, "air.json"));
    expect(report.core.projections[0]).toMatchObject({ id: "canonical", state: "corrupt" });
    expect(report.core.projections[0].detail).toContain("Canonical AIR is corrupt:");
  });

  it("prefers air.yaml over air.json when both exist, even when air.yaml is the corrupt one", async () => {
    const dir = await paymentsBundle();
    // air.json remains a perfectly valid canonical AIR the whole time.
    writeFileSync(join(dir, "air.yaml"), "not: [valid\n");
    const report = await buildStatusReport(dir);
    expect(report.paths.canonicalAir).toBe(join(dir, "air.yaml"));
    expect(report.core.projections[0].state).toBe("corrupt");
    expect(report.serviceId).toBeNull();
  });

  it("accepts a non-standard AIR filename passed directly, verifying it against its own regeneration", async () => {
    const dir = freshDir();
    const air = await compile({
      spec: read("openapi.yaml"),
      manifest: read("anvil.yaml"),
      serviceId: "payments",
    });
    const customPath = join(dir, "service.definition.yaml");
    writeFileSync(customPath, generateBundle(air).files["air.yaml"] as string);
    const report = await buildStatusReport(customPath);
    expect(report.paths.canonicalAir).toBe(customPath);
    expect(report.core.projections[0]).toMatchObject({ id: "canonical", state: "fresh" });
    // Every other compiler-owned projection is absent from this ad-hoc directory.
    expect(
      report.core.projections
        .filter((projection) => projection.id !== "canonical")
        .every((projection) => projection.state === "missing"),
    ).toBe(true);
  });

  it("reports a corrupt non-standard AIR filename with its resolved path, never null", async () => {
    const dir = freshDir();
    const customPath = join(dir, "weird.yaml");
    writeFileSync(customPath, "not: [valid\n");
    const report = await buildStatusReport(customPath);
    expect(report.paths.canonicalAir).toBe(customPath);
    expect(report.core.projections[0].state).toBe("corrupt");
  });
});

describe("buildStatusReport — certification record states", () => {
  it("marks certification corrupt when certification.json is not valid JSON", async () => {
    const dir = await paymentsBundle();
    writeFileSync(join(dir, "certification.json"), "{not json");
    const report = await buildStatusReport(dir);
    expect(report.certification).toMatchObject({
      state: "corrupt",
      bundleHash: null,
      certifiedAt: null,
    });
    expect(report.certification.detail).toContain("not valid JSON");
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "status.certification.corrupt", severity: "warning" }),
    );
  });

  it("marks certification corrupt when certification.json is well-formed but schema-invalid", async () => {
    const dir = await paymentsBundle();
    writeFileSync(join(dir, "certification.json"), JSON.stringify({ hello: "world" }));
    const report = await buildStatusReport(dir);
    expect(report.certification.state).toBe("corrupt");
    expect(report.certification.detail).toContain("does not match the certification schema");
  });

  it("marks a passing certification stale once the bundle is tampered afterward (core drift dominates nextAction)", async () => {
    const dir = await paymentsBundle();
    const certify = bufferIO();
    expect(await runAnvilCli(["certify", dir], { io: certify }), certify.text()).toBe(0);
    writeFileSync(join(dir, "docs", "README.md"), "tampered after certification", "utf8");
    const report = await buildStatusReport(dir);
    expect(report.certification.state).toBe("stale");
    // Tampering a compiler-owned byte also fails contract.generated-bytes-agree, which
    // misaligns core and cascades the idempotency store contract to stale too — repair-core
    // outranks certify in nextSafeAction's priority order.
    expect(report.core.state).toBe("misaligned");
    expect(report.idempotency?.store.contractState).toBe("stale");
    expect(report.nextAction.code).toBe("repair-core");
  });

  it("prioritizes certify over release when only the certification record itself is stale", async () => {
    const dir = await paymentsBundle();
    const certify = bufferIO();
    expect(await runAnvilCli(["certify", dir], { io: certify }), certify.text()).toBe(0);
    // Rewrite certification.json in place with a bundleHash that can never match current
    // bytes, without touching any compiler-owned generated file: core stays aligned.
    const path = join(dir, "certification.json");
    const cert = JSON.parse(readFileSync(path, "utf8"));
    cert.bundleHash = "0".repeat(64);
    writeFileSync(path, JSON.stringify(cert, null, 2));
    const report = await buildStatusReport(dir);
    expect(report.certification.state).toBe("stale");
    expect(report.core.state).toBe("aligned");
    expect(report.nextAction.code).toBe("certify");
  });

  it("marks a bundle that never passed certification as failed, not stale", async () => {
    const dir = await paymentsBundle();
    const catalogPath = join(dir, "catalog.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    catalog.operations[0].cli = "payments something-else";
    writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
    const certify = bufferIO();
    expect(await runAnvilCli(["certify", dir], { io: certify })).toBe(1);
    const report = await buildStatusReport(dir);
    expect(report.certification.state).toBe("failed");
    expect(report.certification.detail).toContain('not "passed"');
  });
});

describe("buildStatusReport — publication record states", () => {
  it("marks publication corrupt when publication.json is not valid JSON", async () => {
    const dir = await paymentsBundle();
    writeFileSync(join(dir, "publication.json"), "{not json");
    const report = await buildStatusReport(dir);
    expect(report.publication.state).toBe("corrupt");
    expect(report.publication.detail).toContain("not valid JSON");
    expect(report.publication.operatorActionRequired).toBe(false);
    expect(report.publication.cloudCallsMade).toBeNull();
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "status.publication.corrupt", severity: "warning" }),
    );
  });

  it("marks publication corrupt when publication.json is well-formed but schema-invalid", async () => {
    const dir = await paymentsBundle();
    writeFileSync(join(dir, "publication.json"), JSON.stringify({ nope: true }));
    const report = await buildStatusReport(dir);
    expect(report.publication.state).toBe("corrupt");
    expect(report.publication.detail).toContain("does not match the publication schema");
  });
});

describe("buildStatusReport — individual projection drift", () => {
  it("marks a deleted mcp/air.json projection as missing", async () => {
    const dir = await paymentsBundle();
    rmSync(join(dir, "mcp", "air.json"));
    const report = await buildStatusReport(dir);
    expect(report.core.projections).toContainEqual(
      expect.objectContaining({ id: "mcp", state: "missing" }),
    );
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "status.core.mcp.missing", severity: "error" }),
    );
    expect(report.core.state).toBe("misaligned");
    expect(report.nextAction.code).toBe("repair-core");
  });

  it("marks a syntactically invalid catalog.json as corrupt, not merely misaligned", async () => {
    const dir = await paymentsBundle();
    writeFileSync(join(dir, "catalog.json"), "{not valid json");
    const report = await buildStatusReport(dir);
    expect(report.core.projections).toContainEqual(
      expect.objectContaining({ id: "catalog", state: "corrupt" }),
    );
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "status.core.catalog.corrupt" }),
    );
  });

  it("marks a syntactically invalid runtime/operations.manifest.json as corrupt", async () => {
    const dir = await paymentsBundle();
    writeFileSync(join(dir, "runtime", "operations.manifest.json"), "not json at all");
    const report = await buildStatusReport(dir);
    expect(report.core.projections).toContainEqual(
      expect.objectContaining({ id: "runtime-manifest", state: "corrupt" }),
    );
  });

  it("skips the redundant canonical-json projection when air.json is itself the canonical file", async () => {
    const dir = await paymentsBundle();
    rmSync(join(dir, "air.yaml"));
    const report = await buildStatusReport(dir);
    expect(report.paths.canonicalAir).toBe(join(dir, "air.json"));
    expect(report.core.projections.map((projection) => projection.id)).not.toContain(
      "canonical-json",
    );
    expect(report.core.projections[0]).toMatchObject({ id: "canonical", state: "fresh" });
  });
});

describe("buildStatusReport — idempotency store contract drift", () => {
  it("reports the store contract missing when deploy/idempotency-store.json is deleted", async () => {
    const dir = await paymentsBundle();
    rmSync(join(dir, "deploy", "idempotency-store.json"));
    const report = await buildStatusReport(dir);
    expect(report.idempotency?.store.contractState).toBe("missing");
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "status.idempotency.contract_missing", severity: "error" }),
    );
    expect(report.core.state).toBe("misaligned");
    expect(report.nextAction.code).toBe("repair-core");
  });

  it("reports the store contract corrupt when it is not valid JSON", async () => {
    const dir = await paymentsBundle();
    writeFileSync(join(dir, "deploy", "idempotency-store.json"), "{not json");
    const report = await buildStatusReport(dir);
    expect(report.idempotency?.store.contractState).toBe("corrupt");
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "status.idempotency.contract_corrupt" }),
    );
  });
});

describe("buildStatusReport — source integrity states", () => {
  it("is unverifiable when the locked-source root cannot be located without --root", async () => {
    // compile() always derives an ephemeral snapshotId from content, even from raw
    // text with no real .anvil/sources directory anywhere — so the ancestor walk
    // that resolveSourceRoot performs finds nothing, and the source is unverifiable
    // (never treated as missing/corrupt) rather than blocking core alignment.
    const dir = await paymentsBundle();
    const report = await buildStatusReport(dir);
    expect(report.source?.snapshotId).toMatch(/^src-/);
    expect(report.source?.root).toBeNull();
    expect(report.source?.integrity.state).toBe("unverifiable");
    expect(report.source?.integrity.diagnostics).toContainEqual(
      expect.objectContaining({ code: "source/root_unresolved" }),
    );
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "status.source.unverifiable", severity: "warning" }),
    );
    expect(report.core.state).toBe("aligned");
    expect(report.nextAction.code).toBe("certify");
  });

  it("is unverifiable with no snapshot id when the canonical AIR itself records none", async () => {
    const dir = await paymentsBundle();
    const airPath = join(dir, "air.yaml");
    const air = airFromYaml(readFileSync(airPath, "utf8"));
    const { snapshotId: _snapshotId, ...sourceWithoutSnapshot } = air.service.source;
    const rewritten = { ...air, service: { ...air.service, source: sourceWithoutSnapshot } };
    writeFileSync(airPath, airToYaml(rewritten));

    const report = await buildStatusReport(dir);
    expect(report.source?.snapshotId).toBeNull();
    expect(report.source?.integrity.state).toBe("unverifiable");
    expect(report.source?.integrity.diagnostics).toContainEqual(
      expect.objectContaining({ code: "source/no_snapshot" }),
    );
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "status.source.unverifiable", severity: "warning" }),
    );
  });

  it("reports the source as missing when an explicit --root points away from the locked snapshot", async () => {
    const root = freshDir();
    const bundle = join(root, "bundle");
    const io = bufferIO();
    const code = await runAnvilCli(
      [
        "compile",
        join(examples, "openapi.yaml"),
        "--manifest",
        join(examples, "anvil.yaml"),
        "--service",
        "payments",
        "--out",
        bundle,
        "--root",
        join(root, "workspace"),
      ],
      { io },
    );
    expect(code, io.text()).toBe(0);

    const wrongRoot = freshDir();
    const report = await buildStatusReport(bundle, { root: wrongRoot });
    expect(report.source?.root).toBe(wrongRoot);
    expect(report.source?.integrity.state).toBe("missing");
    expect(report.source?.integrity.diagnostics).toContainEqual(
      expect.objectContaining({ code: "source/not_found" }),
    );
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "status.source.missing", severity: "error" }),
    );
    expect(report.core.state).toBe("misaligned");
  });
});

describe("buildStatusReport — gateway import receipt states", () => {
  it("is bound for a freshly imported gateway bundle, with no gateway_import diagnostics", async () => {
    const { bundle, root } = await importedGatewayBundle();
    const report = await buildStatusReport(bundle, { root });
    expect(report.gatewayImport).toMatchObject({ state: "bound" });
    expect(report.gatewayImport?.identity).toMatchObject({ vendor: "kong" });
    expect(
      report.diagnostics.some((diagnostic) => diagnostic.code.startsWith("status.gateway_import.")),
    ).toBe(false);
  });

  it("is invalid when import.receipt.json is not valid JSON", async () => {
    const { bundle, root } = await importedGatewayBundle();
    writeFileSync(join(bundle, "import.receipt.json"), "{not json");
    const report = await buildStatusReport(bundle, { root });
    expect(report.gatewayImport?.state).toBe("invalid");
    expect(report.gatewayImport?.detail).toContain("not valid JSON");
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "status.gateway_import.invalid", severity: "error" }),
    );
    expect(report.nextAction.code).toBe("repair-core");
  });

  it("is invalid when import.receipt.json fails the receipt-view schema", async () => {
    const { bundle, root } = await importedGatewayBundle();
    writeFileSync(join(bundle, "import.receipt.json"), JSON.stringify({ hello: "world" }));
    const report = await buildStatusReport(bundle, { root });
    expect(report.gatewayImport?.state).toBe("invalid");
    expect(report.gatewayImport?.detail).toContain("Gateway receipt view is invalid:");
  });

  it("is invalid when the recorded identity digest is corrupt", async () => {
    const { bundle, root } = await importedGatewayBundle();
    const path = join(bundle, "import.receipt.json");
    const view = JSON.parse(readFileSync(path, "utf8"));
    view.selection.identity.digest = `sha256:${"0".repeat(64)}`;
    writeFileSync(path, JSON.stringify(view, null, 2));
    const report = await buildStatusReport(bundle, { root });
    expect(report.gatewayImport?.state).toBe("invalid");
    expect(report.gatewayImport?.detail).toContain("Gateway identity digest is corrupt");
    expect(report.nextAction.code).toBe("repair-core");
  });

  it("is stale when the receipt view records stale output lineage", async () => {
    const { bundle, root } = await importedGatewayBundle();
    const path = join(bundle, "import.receipt.json");
    const view = JSON.parse(readFileSync(path, "utf8"));
    view.lineage = {
      status: "stale",
      reason: "output changed after this receipt was recorded",
      currentOutputDigest: view.output.digest,
      currentOutputFiles: view.output.files,
    };
    writeFileSync(path, JSON.stringify(view, null, 2));
    const report = await buildStatusReport(bundle, { root });
    expect(report.gatewayImport?.state).toBe("stale");
    expect(report.gatewayImport?.detail).toBe("output changed after this receipt was recorded");
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "status.gateway_import.stale", severity: "error" }),
    );
    expect(report.nextAction).toMatchObject({ code: "operator-action-required" });
  });

  it("is legacy when the receipt view has no first-class identity", async () => {
    const { bundle, root } = await importedGatewayBundle();
    const path = join(bundle, "import.receipt.json");
    const view = JSON.parse(readFileSync(path, "utf8"));
    delete view.selection.identity;
    writeFileSync(path, JSON.stringify(view, null, 2));
    const report = await buildStatusReport(bundle, { root });
    expect(report.gatewayImport?.state).toBe("legacy");
    expect(report.gatewayImport?.identity).toBeNull();
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "status.gateway_import.legacy", severity: "warning" }),
    );
    expect(report.nextAction).toMatchObject({ code: "operator-action-required" });
  });
});

describe("buildStatusReport — non-gemini-enterprise target setup drift", () => {
  it("is corrupt when a discovered target directory has no setup.json", async () => {
    const dir = await paymentsBundle();
    mkdirSync(join(dir, "targets", "custom-target"), { recursive: true });
    writeFileSync(join(dir, "targets", "custom-target", "notes.txt"), "not a setup file");
    const report = await buildStatusReport(dir);
    const target = report.targets.find((entry) => entry.targetId === "custom-target");
    expect(target).toMatchObject({
      state: "corrupt",
      detail: expect.stringContaining("is missing"),
    });
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "status.target.setup_corrupt", severity: "warning" }),
    );
    expect(report.nextAction.code).toBe("retarget");
  });

  it("is corrupt when setup.json is not valid JSON", async () => {
    const dir = await paymentsBundle();
    mkdirSync(join(dir, "targets", "custom-target"), { recursive: true });
    writeFileSync(join(dir, "targets", "custom-target", "setup.json"), "{not json");
    const report = await buildStatusReport(dir);
    const target = report.targets.find((entry) => entry.targetId === "custom-target");
    expect(target?.state).toBe("corrupt");
    expect(target?.detail).toContain("not valid JSON");
  });

  it("is corrupt when setup.json has no surfaceSignatureDigest", async () => {
    const dir = await paymentsBundle();
    mkdirSync(join(dir, "targets", "custom-target"), { recursive: true });
    writeFileSync(
      join(dir, "targets", "custom-target", "setup.json"),
      JSON.stringify({ config: { surface: "custom-mcp" } }),
    );
    const report = await buildStatusReport(dir);
    const target = report.targets.find((entry) => entry.targetId === "custom-target");
    expect(target).toMatchObject({
      state: "corrupt",
      config: { surface: "custom-mcp" },
      detail: expect.stringContaining("has no surfaceSignatureDigest"),
    });
  });

  it("is stale when the recorded surface signature no longer matches canonical AIR", async () => {
    const dir = await paymentsBundle();
    mkdirSync(join(dir, "targets", "custom-target"), { recursive: true });
    writeFileSync(
      join(dir, "targets", "custom-target", "setup.json"),
      JSON.stringify({ surfaceSignatureDigest: "sha256:deadbeef" }),
    );
    const report = await buildStatusReport(dir);
    const target = report.targets.find((entry) => entry.targetId === "custom-target");
    expect(target?.state).toBe("stale");
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "status.target.kit_stale", severity: "warning" }),
    );
    expect(report.nextAction.code).toBe("retarget");
  });

  it("is fresh when the recorded surface signature matches canonical AIR exactly", async () => {
    const dir = await paymentsBundle();
    const air = airFromYaml(readFileSync(join(dir, "air.yaml"), "utf8"));
    const digest = surfaceSignatureFor(air).digest;
    mkdirSync(join(dir, "targets", "custom-target"), { recursive: true });
    writeFileSync(
      join(dir, "targets", "custom-target", "setup.json"),
      JSON.stringify({ surfaceSignatureDigest: digest }),
    );
    const report = await buildStatusReport(dir);
    const target = report.targets.find((entry) => entry.targetId === "custom-target");
    expect(target).toMatchObject({ state: "fresh", recordedSurfaceSignature: digest });
  });

  it("is unverifiable when canonical AIR itself is not valid", async () => {
    const dir = freshDir();
    mkdirSync(join(dir, "targets", "custom-target"), { recursive: true });
    writeFileSync(
      join(dir, "targets", "custom-target", "setup.json"),
      JSON.stringify({ surfaceSignatureDigest: "sha256:deadbeef" }),
    );
    writeFileSync(join(dir, "air.yaml"), "not: [valid\n");
    const report = await buildStatusReport(dir);
    const target = report.targets.find((entry) => entry.targetId === "custom-target");
    expect(target).toMatchObject({
      state: "unverifiable",
      recordedSurfaceSignature: "sha256:deadbeef",
      currentSurfaceSignature: null,
    });
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "status.target.unverifiable", severity: "warning" }),
    );
  });
});

describe("buildStatusReport — operation counts and nextAction priority", () => {
  it("counts operations by state (approved vs pending vs blocked) and routes to resolve-blocked first", async () => {
    const manifest = `
service:
  name: payments
  display_name: Payments API
  owner: payments-platform
  environment: prod

auth:
  type: oauth2
  scopes:
    - payments.read
    - payments.write

operations:
  createRefund:
    side_effect: mutation
    risk: financial
    reversible: false
    idempotency:
      strategy: required_request_key
      key_location: header
      header: Idempotency-Key
    confirmation:
      required: true
      risk: financial
    state: review_required
  capturePayment:
    side_effect: mutation
    risk: financial
    idempotency:
      strategy: natural
    confirmation:
      required: true
      risk: financial
    state: blocked
  getCustomer:
    state: approved
  getPayment:
    state: generated
`;
    const air = await compile({ spec: read("openapi.yaml"), manifest, serviceId: "payments" });
    const dir = freshDir();
    writeBundle(dir, generateBundle(air));

    const report = await buildStatusReport(dir);
    expect(report.operations).toMatchObject({
      total: 4,
      generated: 1,
      approved: 1,
      review_required: 1,
      blocked: 1,
      deprecated: 0,
      awaitingApproval: 2,
    });
    // Safety-contract invariant: unapproved mutations never enter the approved-writes ledger.
    expect(report.idempotency?.writes).toEqual([]);
    expect(report.nextAction).toMatchObject({
      code: "resolve-blocked",
      command: `anvil inspect ${dir}`,
    });
  });

  it("routes to inspect-approve, not resolve-blocked, when nothing is blocked but approval is pending", async () => {
    const manifest = `
service:
  name: payments
  display_name: Payments API
  owner: payments-platform
  environment: prod

auth:
  type: oauth2
  scopes:
    - payments.read
    - payments.write

operations:
  createRefund:
    side_effect: mutation
    risk: financial
    reversible: false
    idempotency:
      strategy: required_request_key
      key_location: header
      header: Idempotency-Key
    confirmation:
      required: true
      risk: financial
    state: review_required
  capturePayment:
    side_effect: mutation
    risk: financial
    idempotency:
      strategy: natural
    confirmation:
      required: true
      risk: financial
    state: approved
  getCustomer:
    state: approved
  getPayment:
    state: approved
`;
    const air = await compile({ spec: read("openapi.yaml"), manifest, serviceId: "payments" });
    const dir = freshDir();
    writeBundle(dir, generateBundle(air));

    const report = await buildStatusReport(dir);
    expect(report.operations).toMatchObject({
      blocked: 0,
      review_required: 1,
      awaitingApproval: 1,
    });
    expect(report.nextAction).toMatchObject({
      code: "inspect-approve",
      command: `anvil inspect ${dir}`,
      reason: "Inspect operation risk, then approve only the intended operation ids.",
    });
  });
});

describe("runStatus — exit code and output shape", () => {
  it("returns 0 and renders human text for an aligned bundle", async () => {
    const dir = await paymentsBundle();
    const io = bufferIO();
    const code = await runStatus(dir, {}, io);
    expect(code).toBe(0);
    expect(io.stdout).toHaveLength(1);
    expect(io.stdout[0]).toContain("Anvil status — payments");
    expect(io.stderr).toEqual([]);
  });

  it("returns 1 and still renders (never throws) for a bundle with drifted projections", async () => {
    const dir = await paymentsBundle();
    rmSync(join(dir, "mcp", "air.json"));
    const io = bufferIO();
    const code = await runStatus(dir, {}, io);
    expect(code).toBe(1);
    expect(io.stdout[0]).toContain("Core projections — MISALIGNED");
  });

  it("emits exactly one JSON document matching buildStatusReport when --json is set", async () => {
    const dir = await paymentsBundle();
    const io = bufferIO();
    const code = await runStatus(dir, { json: true }, io);
    const report = await buildStatusReport(dir);
    expect(io.stdout).toHaveLength(1);
    expect(JSON.parse(io.stdout[0] ?? "")).toEqual(JSON.parse(JSON.stringify(report)));
    expect(code).toBe(report.core.state === "aligned" ? 0 : 1);
  });
});

/** Build a minimal but structurally complete StatusReport for pure render-formatting tests. */
function minimalReport(overrides: Partial<StatusReport> = {}): StatusReport {
  const hash = "a".repeat(64);
  return {
    schemaVersion: 1,
    serviceId: "widgets",
    paths: { input: "/bundle", bundle: "/bundle", canonicalAir: "/bundle/air.yaml" },
    source: null,
    operations: null,
    idempotency: null,
    gatewayImport: null,
    core: { state: "aligned", bundleHash: hash, projections: [], contractChecks: [] },
    certification: {
      state: "fresh",
      path: "/bundle/certification.json",
      bundleHash: hash,
      certifiedAt: "2026-01-01T00:00:00Z",
      detail: "ok",
    },
    executableEvidence: {
      selftest: {
        lane: "selftest",
        file: "selftest.report.json",
        state: "fresh",
        fresh: true,
        passed: true,
        bundleHash: hash,
        detail: "ok",
        path: "/bundle/selftest.report.json",
      },
      conformance: {
        lane: "conformance",
        file: "conformance.report.json",
        state: "fresh",
        fresh: true,
        passed: true,
        bundleHash: hash,
        detail: "ok",
        path: "/bundle/conformance.report.json",
      },
      simulation: {
        lane: "simulation",
        file: "simulation.report.json",
        state: "fresh",
        fresh: true,
        passed: true,
        bundleHash: hash,
        detail: "ok",
        path: "/bundle/simulation.report.json",
      },
    },
    publication: {
      state: "planned",
      path: "/bundle/publication.json",
      bundleHash: hash,
      plannedAt: "2026-01-01T00:00:00Z",
      publishedAt: null,
      target: "cloud-run",
      environment: "dev",
      cloudCallsMade: false,
      operatorActionRequired: true,
      executableEvidenceGate: "passed",
      evidenceWaiverReason: null,
      detail: "planned",
    },
    targets: [],
    nextAction: { code: "operator-action-required", command: null, reason: "done" },
    diagnostics: [],
    ...overrides,
  };
}

describe("renderStatusReport — formatting branches not reachable through a compiled bundle", () => {
  it("omits every optional section when the report carries none of them", () => {
    const text = renderStatusReport(minimalReport());
    expect(text).not.toContain("Source");
    expect(text).not.toContain("Gateway import");
    expect(text).not.toContain("Operations");
    expect(text).not.toContain("Writes & idempotency");
    expect(text).not.toContain("Diagnostics");
    expect(text).toContain("Targets");
    expect(text).toContain("  none discovered");
  });

  it("renders a single not-required idempotency line when no managed backend is required", () => {
    const text = renderStatusReport(
      minimalReport({
        idempotency: {
          writes: [],
          store: {
            contractPath: "/bundle/deploy/idempotency-store.json",
            contractState: "fresh",
            required: false,
            backend: "none",
            databaseId: null,
            databaseTerraformVariable: null,
            provisioningModeTerraformVariable: null,
            provisioningModeDefault: null,
            collectionGroup: null,
            runtimeUriTemplate: null,
            locationTerraformVariable: null,
            locationImmutable: null,
            detail: "no managed store required",
          },
          liveReadiness: {
            state: "not-required",
            path: null,
            mutates: null,
            deploymentStartupGate: null,
            livenessRestartOnProviderFailure: null,
            detail: "No approved mutation requires a managed idempotency store.",
          },
        },
      }),
    );
    expect(text).toContain(
      "store contract: fresh · not required · /bundle/deploy/idempotency-store.json",
    );
    expect(text).toContain("  live readiness: not-required");
    expect(text).not.toContain("planned store:");
  });

  it("renders target coordinates only when the config yields at least one part", () => {
    const text = renderStatusReport(
      minimalReport({
        targets: [
          {
            targetId: "gemini-enterprise",
            path: "/bundle/targets/gemini-enterprise/setup.json",
            state: "fresh",
            recordedSurfaceSignature: "sha256:abc",
            currentSurfaceSignature: "sha256:abc",
            config: { surface: "agent-gateway", appLocation: "global", serverAuth: "oidc" },
            integrity: null,
            detail: "matches",
          },
          {
            targetId: "no-config-target",
            path: "/bundle/targets/no-config-target/setup.json",
            state: "fresh",
            recordedSurfaceSignature: "sha256:abc",
            currentSurfaceSignature: "sha256:abc",
            config: null,
            integrity: null,
            detail: "matches",
          },
        ],
      }),
    );
    expect(text).toContain("agent-gateway · GE global · oidc");
    const lines = text.split("\n");
    const noConfigIndex = lines.findIndex((line) => line.includes("no-config-target"));
    expect(noConfigIndex).toBeGreaterThan(-1);
    // No coordinate line follows: the next line is the trailing blank before "Next safe action".
    expect(lines[noConfigIndex + 1]).toBe("");
  });

  it("renders diagnostics with uppercased severity", () => {
    const text = renderStatusReport(
      minimalReport({
        diagnostics: [
          { code: "status.example.warn", severity: "warning", detail: "a warning" },
          { code: "status.example.err", severity: "error", detail: "an error", path: "/x" },
        ],
      }),
    );
    expect(text).toContain("Diagnostics");
    expect(text).toContain("[WARNING] status.example.warn: a warning");
    expect(text).toContain("[ERROR] status.example.err: an error");
  });

  it("omits coordinate/owner/evidence/verify lines for a legacy receipt with no identity", () => {
    const text = renderStatusReport(
      minimalReport({
        gatewayImport: {
          state: "legacy",
          importId: "gwi-0000000000000000",
          receiptDigest: `sha256:${"0".repeat(64)}`,
          identity: null,
          verifyCommand: null,
          detail: "legacy receipt",
        },
      }),
    );
    expect(text).toContain("Gateway import");
    expect(text).toContain("state: legacy — legacy receipt");
    expect(text).not.toContain("coordinate:");
    expect(text).not.toContain("owner:");
    expect(text).not.toContain("verify:");
  });
});
