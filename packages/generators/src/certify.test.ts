import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AirDocument, hashCanonical } from "@anvil/air";
import { approveCapability, compile, type GatewayImportReceiptView } from "@anvil/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import { generateBundle } from "./bundle.js";
import { generateCapabilityBundle } from "./capability-view.js";
import {
  bundleHash,
  CERTIFICATION_FILE,
  type Certification,
  certifyBundle,
  executableEvidenceReady,
  executableEvidenceStatuses,
  readBundleDir,
  verifyCertification,
} from "./certify.js";

const read = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/payments/${rel}`, import.meta.url)),
    "utf8",
  );

let air: AirDocument;
let files: Record<string, string>;

beforeAll(async () => {
  air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
  files = generateBundle(air).files;
});

/** A fixed clock so certifications are comparable byte-for-byte. */
const clock = (iso: string) => () => iso;

const failedIds = (cert: Certification) =>
  cert.checks.filter((c) => c.status === "failed").map((c) => c.id);

const sha = (character = "a") => `sha256:${character.repeat(64)}`;

function gatewayReceipt(
  overrides: Partial<GatewayImportReceiptView> = {},
): GatewayImportReceiptView {
  const outputFiles: GatewayImportReceiptView["output"]["files"] = [];
  return {
    schemaVersion: 1,
    viewType: "anvil.gateway-import-receipt-view",
    redacted: true,
    importId: "gwi-0123456789abcdef",
    receiptDigest: sha(),
    lineage: { status: "bound" },
    privateReceipt: {
      workspaceRoot: "$WORKSPACE",
      storedAs: ".anvil/imports/gwi-0123456789abcdef/import.receipt.json",
      verifyCommand: "anvil estate verify gwi-0123456789abcdef --root .",
    },
    selection: {
      vendor: "fixture",
      apiId: "payments",
      export: { format: "text", sha256: sha(), bytes: 10 },
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
        sourceHash: sha(),
        entrypoint: "openapi.yaml",
      },
    },
    overlays: [],
    diagnostics: [],
    blockers: [],
    output: { digest: `sha256:${hashCanonical(outputFiles)}`, files: outputFiles },
    ...overrides,
  };
}

function capabilityBundleWithParentGateway(receipt = gatewayReceipt()) {
  const parent = structuredClone(air);
  approveCapability(parent, "payments.refunds");
  return generateCapabilityBundle(parent, "payments.refunds", {
    parentGatewayReceipt: receipt,
  });
}

describe("certification: clean bundle", () => {
  it("passes every gate on the compiled payments bundle", () => {
    const cert = certifyBundle(files, air, { now: clock("2026-07-10T00:00:00Z") });
    expect(failedIds(cert)).toEqual([]);
    expect(cert.status).toBe("passed");
    expect(cert.serviceId).toBe("payments");
    // All four gates are represented in the checks.
    const gates = new Set(cert.checks.map((c) => c.gate));
    expect([...gates].sort()).toEqual(["contract", "runtime", "safety", "semantic"]);
  });

  it("is reproducible: identical checks and hash, only certifiedAt differs", () => {
    const a = certifyBundle(files, air, { now: clock("2026-07-10T00:00:00Z") });
    const b = certifyBundle(files, air, { now: clock("2026-07-11T12:34:56Z") });
    expect(a.certifiedAt).not.toBe(b.certifiedAt);
    const { certifiedAt: _a, ...restA } = a;
    const { certifiedAt: _b, ...restB } = b;
    expect(restA).toEqual(restB);
  });

  it("derives the bundle hash from content, ignoring its own record files", () => {
    const h = bundleHash(files);
    expect(
      bundleHash({
        ...files,
        [CERTIFICATION_FILE]: "{}",
        "publication.json": "{}",
        "selftest.report.json": "{}",
        "conformance.report.json": "{}",
        "conformance.live.report.json": "{}",
        "simulation.report.json": "{}",
        "review.report.json": "{}",
      }),
    ).toBe(h);
    expect(bundleHash({ ...files, "runtime/custom.report.json": "{}" })).not.toBe(h);
    expect(bundleHash({ ...files, "docs/README.md": "tampered" })).not.toBe(h);
    // Adding or removing a file changes the identity too, not just content edits.
    expect(bundleHash({ ...files, "extra.txt": "x" })).not.toBe(h);
  });

  it("refuses unexpected symlinks instead of omitting them from bundle identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-cert-identity-"));
    const external = join(dir, "..", `${dir.split("/").at(-1)}-external.txt`);
    try {
      mkdirSync(join(dir, "skill"), { recursive: true });
      writeFileSync(external, "mutable external instructions");
      symlinkSync(external, join(dir, "skill", "external.md"));
      expect(() => readBundleDir(dir)).toThrow(/Unexpected symlink.*skill\/external\.md/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(external, { force: true });
    }
  });
});

describe("certification: CONTRACT gate", () => {
  it("fails when the runtime manifest drops an approved operation", () => {
    const manifest = JSON.parse(files["runtime/operations.manifest.json"] as string);
    manifest.operations = manifest.operations.filter(
      (o: { id: string }) => o.id !== "payments.refunds.create",
    );
    const tampered = {
      ...files,
      "runtime/operations.manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    };
    const cert = certifyBundle(tampered, air);
    expect(cert.status).toBe("failed");
    expect(failedIds(cert)).toContain("contract.surfaces-agree");
    const detail = cert.checks.find((c) => c.id === "contract.surfaces-agree")?.detail ?? "";
    expect(detail).toContain("payments.refunds.create");
  });

  it("fails when the CLI surface disagrees with the MCP surface", () => {
    // Rename one tool in the CLI's air.json copy — the surfaces now disagree.
    const cliAir = JSON.parse(files["cli/air.json"] as string);
    const refund = cliAir.operations.find(
      (o: { id: string }) => o.id === "payments.refunds.create",
    );
    refund.mcp.toolName = "payments_delete_everything";
    const tampered = { ...files, "cli/air.json": JSON.stringify(cliAir) };
    const cert = certifyBundle(tampered, air);
    expect(failedIds(cert)).toContain("contract.surfaces-agree");
  });

  it("fails when the AIR loaded by the deployed runtime exposes a different surface", () => {
    const runtimeAir = JSON.parse(files["runtime/air.json"] as string);
    const hidden = runtimeAir.operations.find(
      (operation: { state: string }) => operation.state !== "approved",
    );
    if (hidden) hidden.state = "approved";
    else runtimeAir.operations[0].mcp.toolName = "runtime_only_tool";
    const cert = certifyBundle(
      { ...files, "runtime/air.json": `${JSON.stringify(runtimeAir, null, 2)}\n` },
      air,
    );
    expect(failedIds(cert)).toContain("contract.surfaces-agree");
    expect(cert.checks.find((check) => check.id === "contract.surfaces-agree")?.detail).toContain(
      "runtime/air.json",
    );
  });

  it("fails when air.json no longer validates through the AIR schema", () => {
    const broken = JSON.parse(files["air.json"] as string);
    broken.operations[0].effect.kind = "yolo";
    const cert = certifyBundle({ ...files, "air.json": JSON.stringify(broken) }, air);
    expect(failedIds(cert)).toContain("contract.air-valid");
  });

  it.each([
    "runtime/server.js",
    "mcp/server.js",
    "cli/payments.mjs",
    "deploy/terraform/main.tf",
  ])("refuses to certify tampered compiler-owned executable/config bytes: %s", (path) => {
    const cert = certifyBundle(
      { ...files, [path]: `${files[path] as string}\n// malicious drift\n` },
      air,
    );
    expect(failedIds(cert)).toContain("contract.generated-bytes-agree");
    expect(
      cert.checks.find((check) => check.id === "contract.generated-bytes-agree")?.detail,
    ).toContain(path);
  });

  it("rejects ghost files inside a compiler-owned executable root", () => {
    const cert = certifyBundle(
      { ...files, "runtime/sidecar-bypass.js": "export const bypass = true;\n" },
      air,
    );
    expect(failedIds(cert)).toContain("contract.generated-bytes-agree");
  });
});

describe("certification: gateway provenance", () => {
  it("fails closed when a gateway-origin bundle drops its receipt view", () => {
    const gatewayAir = structuredClone(air);
    gatewayAir.service.source.origin = { kind: "kong", uri: "kong://payments" };
    const gatewayFiles = generateBundle(gatewayAir).files;
    const cert = certifyBundle(gatewayFiles, gatewayAir);

    expect(failedIds(cert)).toEqual(
      expect.arrayContaining([
        "contract.gateway-lineage-current",
        "contract.gateway-blockers-resolved",
      ]),
    );
    expect(
      cert.checks.find((candidate) => candidate.id === "contract.gateway-lineage-current")?.detail,
    ).toContain("import.receipt.json is missing");
  });

  it.each([
    "not json\n",
    '{"not":"a receipt"}\n',
  ])("fails both lineage and blocker checks when a top-level receipt cannot be trusted", (receipt) => {
    const cert = certifyBundle({ ...files, "import.receipt.json": receipt }, air);
    expect(failedIds(cert)).toEqual(
      expect.arrayContaining([
        "contract.gateway-lineage-current",
        "contract.gateway-blockers-resolved",
      ]),
    );
    expect(
      cert.checks.find((candidate) => candidate.id === "contract.gateway-blockers-resolved")
        ?.detail,
    ).toContain("blockers cannot be verified");
  });

  it("accepts a schema-valid, bound, blocker-free copied parent receipt", () => {
    const built = capabilityBundleWithParentGateway();
    const cert = certifyBundle(built.bundle.files, built.view);
    expect(cert.status).toBe("passed");
    expect(failedIds(cert)).not.toContain("contract.capability-parent-gateway-provenance");
    expect(
      cert.checks.find(
        (candidate) => candidate.id === "contract.capability-parent-gateway-provenance",
      ),
    ).toMatchObject({ status: "passed" });
  });

  it("fails when a declared parent receipt is missing or fails schema validation", () => {
    const built = capabilityBundleWithParentGateway();
    const receiptPath = "provenance/parent-gateway-import.receipt.json";
    const { [receiptPath]: _missing, ...withoutReceipt } = built.bundle.files;
    const missing = certifyBundle(withoutReceipt, built.view);
    expect(
      missing.checks.find(
        (candidate) => candidate.id === "contract.capability-parent-gateway-provenance",
      ),
    ).toMatchObject({ status: "failed", detail: expect.stringContaining("missing") });

    const malformed = certifyBundle(
      { ...built.bundle.files, [receiptPath]: '{"not":"a receipt"}\n' },
      built.view,
    );
    expect(
      malformed.checks.find(
        (candidate) => candidate.id === "contract.capability-parent-gateway-provenance",
      ),
    ).toMatchObject({ status: "failed", detail: expect.stringContaining("schema") });
  });

  it.each([
    [
      "importId",
      (declaration: Record<string, unknown>) => {
        declaration.importId = "gwi-fedcba9876543210";
      },
    ],
    [
      "receiptDigest",
      (declaration: Record<string, unknown>) => {
        declaration.receiptDigest = sha("b");
      },
    ],
    [
      "receiptViewDigest",
      (declaration: Record<string, unknown>) => {
        declaration.receiptViewDigest = "b".repeat(64);
      },
    ],
    [
      "outputDigest",
      (declaration: Record<string, unknown>) => {
        declaration.outputDigest = sha("b");
      },
    ],
    [
      "lineage",
      (declaration: Record<string, unknown>) => {
        declaration.lineage = "stale";
      },
    ],
    [
      "blockerCount",
      (declaration: Record<string, unknown>) => {
        declaration.blockerCount = 1;
      },
    ],
  ])("detects a %s mismatch between bundle.json and the copied receipt", (field, mutate) => {
    const built = capabilityBundleWithParentGateway();
    const manifest = JSON.parse(built.bundle.files["bundle.json"] as string) as {
      parentGatewayImport: Record<string, unknown>;
    };
    mutate(manifest.parentGatewayImport);
    const cert = certifyBundle(
      {
        ...built.bundle.files,
        "bundle.json": `${JSON.stringify(manifest, null, 2)}\n`,
      },
      built.view,
    );
    expect(
      cert.checks.find(
        (candidate) => candidate.id === "contract.capability-parent-gateway-provenance",
      ),
    ).toMatchObject({ status: "failed", detail: expect.stringContaining(`${field} mismatch`) });
  });

  it("rejects a copied receipt whose declared output digest does not hash its file manifest", () => {
    const built = capabilityBundleWithParentGateway();
    const receiptPath = "provenance/parent-gateway-import.receipt.json";
    const receipt = JSON.parse(built.bundle.files[receiptPath] as string);
    receipt.output.digest = sha("b");
    const manifest = JSON.parse(built.bundle.files["bundle.json"] as string);
    manifest.parentGatewayImport.outputDigest = receipt.output.digest;
    manifest.parentGatewayImport.receiptViewDigest = hashCanonical(receipt);

    const cert = certifyBundle(
      {
        ...built.bundle.files,
        [receiptPath]: `${JSON.stringify(receipt, null, 2)}\n`,
        "bundle.json": `${JSON.stringify(manifest, null, 2)}\n`,
      },
      built.view,
    );
    expect(
      cert.checks.find(
        (candidate) => candidate.id === "contract.capability-parent-gateway-provenance",
      ),
    ).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("output manifest hashes"),
    });
  });

  it("refuses matching but stale or blocked parent lineage", () => {
    const receipt = gatewayReceipt({
      lineage: {
        status: "stale",
        reason: "parent output changed",
        currentOutputDigest: sha("b"),
        currentOutputFiles: [],
      },
      blockers: [
        {
          level: "warning",
          code: "gateway/opaque_policy",
          message: "Plugin semantics require review.",
        },
      ],
    });
    const built = capabilityBundleWithParentGateway(receipt);
    const manifest = JSON.parse(built.bundle.files["bundle.json"] as string);
    expect(manifest.parentGatewayImport).toMatchObject({
      receiptViewDigest: hashCanonical(receipt),
      lineage: "stale",
      blockerCount: 1,
    });

    const cert = certifyBundle(built.bundle.files, built.view);
    const provenance = cert.checks.find(
      (candidate) => candidate.id === "contract.capability-parent-gateway-provenance",
    );
    expect(provenance).toMatchObject({ status: "failed" });
    expect(provenance?.detail).toContain("lineage is stale");
    expect(provenance?.detail).toContain("gateway/opaque_policy");
  });
});

describe("certification: SAFETY gate", () => {
  it("fails when a risky mutation loses its confirmation requirement", () => {
    // Tamper the deployed policy only — AIR stays clean, so this proves the gate
    // judges the runtime manifest, not just the canonical model.
    const manifest = JSON.parse(files["runtime/operations.manifest.json"] as string);
    const refund = manifest.operations.find(
      (o: { id: string }) => o.id === "payments.refunds.create",
    );
    refund.confirmation.required = false;
    const tampered = {
      ...files,
      "runtime/operations.manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    };
    const cert = certifyBundle(tampered, air);
    expect(cert.status).toBe("failed");
    expect(failedIds(cert)).toContain("safety.confirmation-required");
  });

  it("fails a retry-unsafe operation (idempotency none + retries on)", () => {
    const unsafe = structuredClone(air);
    const refund = unsafe.operations.find((o) => o.id === "payments.refunds.create");
    if (!refund) throw new Error("fixture: refund operation missing");
    refund.idempotency.mode = "none";
    refund.retries.mode = "safe";
    const bundle = generateBundle(unsafe).files;
    const cert = certifyBundle(bundle, unsafe);
    expect(failedIds(cert)).toContain("safety.no-retry-without-idempotency");
  });

  it("fails a retry-enabled operation whose basis is unproven", () => {
    const unsafe = structuredClone(air);
    const capture = unsafe.operations.find((o) => o.id === "payments.capture.create");
    if (!capture) throw new Error("fixture: capture operation missing");
    capture.retries.mode = "safe";
    capture.retries.basis = "unproven";
    const cert = certifyBundle(generateBundle(unsafe).files, unsafe);
    expect(failedIds(cert)).toContain("safety.retry-basis-proven");
  });

  it("fails incoherent secret handling (auth without a credential source)", () => {
    const unsafe = structuredClone(air);
    const refund = unsafe.operations.find((o) => o.id === "payments.refunds.create");
    if (!refund) throw new Error("fixture: refund operation missing");
    refund.auth.secretSource = "none";
    const cert = certifyBundle(generateBundle(unsafe).files, unsafe);
    expect(failedIds(cert)).toContain("safety.secret-handling-coherent");
  });

  it("fails a tampered AIR whose declared principal disagrees with the executed grant", () => {
    const unsafe = structuredClone(air);
    const refund = unsafe.operations.find((o) => o.id === "payments.refunds.create");
    if (!refund) throw new Error("fixture: refund operation missing");
    refund.auth.type = "oauth2_client_credentials";
    refund.auth.principal = "end_user";
    refund.auth.secretSource = "env";
    refund.auth.provider = { grant: "client_credentials" };
    const cert = certifyBundle(generateBundle(unsafe).files, unsafe);
    expect(failedIds(cert)).toContain("safety.auth-authority-coherent");
  });

  it("fails a tampered AIR whose OAuth type and provider grant disagree", () => {
    const unsafe = structuredClone(air);
    const refund = unsafe.operations.find((o) => o.id === "payments.refunds.create");
    if (!refund) throw new Error("fixture: refund operation missing");
    refund.auth.type = "oauth2_on_behalf_of";
    refund.auth.principal = "delegated";
    refund.auth.secretSource = "env";
    refund.auth.provider = { grant: "client_credentials" };
    const cert = certifyBundle(generateBundle(unsafe).files, unsafe);
    expect(failedIds(cert)).toContain("safety.auth-authority-coherent");
  });

  it("fails a tampered API-key AIR that smuggles JWT-bearer grant mechanics", () => {
    const unsafe = structuredClone(air);
    const refund = unsafe.operations.find((o) => o.id === "payments.refunds.create");
    if (!refund) throw new Error("fixture: refund operation missing");
    refund.auth.type = "api_key";
    refund.auth.principal = "service";
    refund.auth.secretSource = "env";
    refund.auth.provider = { grant: "jwt_bearer" };
    const cert = certifyBundle(generateBundle(unsafe).files, unsafe);
    expect(failedIds(cert)).toContain("safety.auth-authority-coherent");
  });

  it.each([
    "mtls",
    "custom_header",
    "oauth2_authorization_code",
  ] as const)("fails certification for approved but unmodeled %s auth", (type) => {
    const unsafe = structuredClone(air);
    const refund = unsafe.operations.find((o) => o.id === "payments.refunds.create");
    if (!refund) throw new Error("fixture: refund operation missing");
    refund.auth.type = type;
    const cert = certifyBundle(generateBundle(unsafe).files, unsafe);
    expect(failedIds(cert)).toContain("safety.auth-runtime-supported");
  });
});

describe("certification: SEMANTIC gate", () => {
  it("fails an approved operation with no description", () => {
    const vague = structuredClone(air);
    const refund = vague.operations.find((o) => o.id === "payments.refunds.create");
    if (!refund) throw new Error("fixture: refund operation missing");
    refund.description = "";
    const cert = certifyBundle(generateBundle(vague).files, vague);
    expect(failedIds(cert)).toContain("semantic.descriptions-present");
  });

  it("fails indistinct sibling descriptions within a capability", () => {
    const vague = structuredClone(air);
    for (const op of vague.operations) {
      if (op.capabilityId === "payments.payments") op.description = "Does the payment thing.";
    }
    const cert = certifyBundle(generateBundle(vague).files, vague);
    expect(failedIds(cert)).toContain("semantic.sibling-descriptions-distinct");
  });

  it("fails a blocking disposition on an approved operation", () => {
    // An irreversible destructive mutation without confirmation is the classic
    // blocking deficiency (confirmation_posture_incomplete).
    const bad = structuredClone(air);
    const refund = bad.operations.find((o) => o.id === "payments.refunds.create");
    if (!refund) throw new Error("fixture: refund operation missing");
    refund.confirmation.required = false;
    const cert = certifyBundle(generateBundle(bad).files, bad);
    expect(failedIds(cert)).toContain("semantic.no-blocked-disposition");
  });
});

describe("certification: RUNTIME gate", () => {
  it("fails when the mock scenarios are missing", () => {
    const { "mock/scenarios.json": _gone, ...rest } = files;
    const cert = certifyBundle(rest, air);
    expect(failedIds(cert)).toContain("runtime.mocks-consistent");
  });

  it("fails when deploy artifacts are missing", () => {
    const { "deploy/terraform/main.tf": _gone, ...rest } = files;
    const cert = certifyBundle(rest, air);
    expect(failedIds(cert)).toContain("runtime.deploy-present");
  });

  it("accepts a bundle whose eval suites were all omitted, given the README", () => {
    // Suites that derive zero cases are not emitted; a bundle can legitimately
    // have none. The README documenting the omission satisfies the gate…
    const noSuites = Object.fromEntries(
      Object.entries(files).filter(
        ([rel]) => !(rel.startsWith("skill/evals/") && rel.endsWith(".yaml")),
      ),
    );
    noSuites["skill/evals/README.md"] = "---\nname: x\ndescription: y\n---\n\n# Omitted\n";
    const cert = certifyBundle(noSuites, air);
    expect(failedIds(cert)).not.toContain("runtime.evals-present");
    const detail = cert.checks.find((c) => c.id === "runtime.evals-present")?.detail ?? "";
    expect(detail).toContain("README.md");

    // …and without the README the same bundle fails: silence is not allowed.
    const { "skill/evals/README.md": _readme, ...silent } = noSuites;
    expect(failedIds(certifyBundle(silent, air))).toContain("runtime.evals-present");
  });

  it("still rejects a present-but-broken eval suite (parse check not weakened)", () => {
    const broken = { ...files, "skill/evals/error_recovery.yaml": "cases: [no suite name]\n" };
    const cert = certifyBundle(broken, air);
    expect(failedIds(cert)).toContain("runtime.evals-present");
  });
});

describe("publication gating: verifyCertification", () => {
  const certified = () => {
    const cert = certifyBundle(files, air, { now: clock("2026-07-10T00:00:00Z") });
    return { ...files, [CERTIFICATION_FILE]: `${JSON.stringify(cert, null, 2)}\n` };
  };

  it("accepts a passing certification for the current bundle bytes", () => {
    const verdict = verifyCertification(certified());
    expect(verdict.ok).toBe(true);
  });

  it("rejects a bundle with no certification", () => {
    const verdict = verifyCertification(files);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("anvil certify");
  });

  it("rejects a stale certification after any tamper", () => {
    const bundle = certified();
    bundle["docs/README.md"] = "tampered after certification";
    const verdict = verifyCertification(bundle);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("stale");
  });

  it("rejects a failed certification even when the hash matches", () => {
    const cert = certifyBundle(files, air, { now: clock("2026-07-10T00:00:00Z") });
    const failed: Certification = { ...cert, status: "failed" };
    const bundle = { ...files, [CERTIFICATION_FILE]: JSON.stringify(failed) };
    const verdict = verifyCertification(bundle);
    expect(verdict.ok).toBe(false);
  });
});

describe("publication gating: executable evidence", () => {
  const reportFiles = (subject = bundleHash(files)) => ({
    "selftest.report.json": JSON.stringify({
      schemaVersion: 1,
      bundleHash: subject,
      summary: { pass: 9, fail: 0, skipped: 1 },
    }),
    "conformance.report.json": JSON.stringify({
      schemaVersion: 1,
      bundleHash: subject,
      summary: { pass: 11, fail: 0, skipped: 0 },
    }),
    "simulation.report.json": JSON.stringify({
      schemaVersion: 1,
      bundleHash: subject,
      summary: {
        coverageCells: 35,
        coveragePassed: 35,
        mutantsKilled: 4,
        ok: true,
      },
    }),
  });

  it("requires every lane to pass against the current generated-content digest", () => {
    const statuses = executableEvidenceStatuses({ ...files, ...reportFiles() });
    expect(executableEvidenceReady(statuses)).toBe(true);
    expect(statuses.selftest).toMatchObject({ state: "fresh", fresh: true, passed: true });
    expect(statuses.conformance).toMatchObject({ state: "fresh", fresh: true, passed: true });
    expect(statuses.simulation).toMatchObject({ state: "fresh", fresh: true, passed: true });
  });

  it("distinguishes stale passing proof from a current failure", () => {
    const reports = reportFiles();
    reports["conformance.report.json"] = JSON.stringify({
      schemaVersion: 1,
      bundleHash: "0".repeat(64),
      summary: { pass: 11, fail: 0, skipped: 0 },
    });
    reports["simulation.report.json"] = JSON.stringify({
      schemaVersion: 1,
      bundleHash: bundleHash(files),
      summary: {
        coverageCells: 35,
        coveragePassed: 34,
        mutantsKilled: 3,
        ok: false,
      },
    });
    const statuses = executableEvidenceStatuses({ ...files, ...reports });
    expect(executableEvidenceReady(statuses)).toBe(false);
    expect(statuses.conformance).toMatchObject({
      state: "stale",
      fresh: false,
      passed: true,
    });
    expect(statuses.simulation).toMatchObject({
      state: "failed",
      fresh: true,
      passed: false,
    });
  });

  it("fails closed on malformed report envelopes", () => {
    const statuses = executableEvidenceStatuses({
      ...files,
      ...reportFiles(),
      "selftest.report.json": "{",
    });
    expect(executableEvidenceReady(statuses)).toBe(false);
    expect(statuses.selftest).toMatchObject({
      state: "corrupt",
      fresh: false,
      passed: null,
    });
  });

  it("does not treat an all-skipped check lane as passing executable proof", () => {
    const reports = reportFiles();
    reports["conformance.report.json"] = JSON.stringify({
      schemaVersion: 1,
      bundleHash: bundleHash(files),
      summary: { pass: 0, fail: 0, skipped: 4 },
    });
    const statuses = executableEvidenceStatuses({ ...files, ...reports });
    expect(executableEvidenceReady(statuses)).toBe(false);
    expect(statuses.conformance).toMatchObject({
      state: "failed",
      fresh: true,
      passed: false,
    });
  });

  it("requires positive complete simulation coverage even when summary.ok claims true", () => {
    const reports = reportFiles();
    reports["simulation.report.json"] = JSON.stringify({
      schemaVersion: 1,
      bundleHash: bundleHash(files),
      summary: {
        coverageCells: 35,
        coveragePassed: 34,
        mutantsKilled: 4,
        ok: true,
      },
    });
    const partial = executableEvidenceStatuses({ ...files, ...reports });
    expect(executableEvidenceReady(partial)).toBe(false);
    expect(partial.simulation).toMatchObject({
      state: "failed",
      fresh: true,
      passed: false,
    });

    reports["simulation.report.json"] = JSON.stringify({
      schemaVersion: 1,
      bundleHash: bundleHash(files),
      summary: {
        coverageCells: 0,
        coveragePassed: 0,
        mutantsKilled: 0,
        ok: true,
      },
    });
    const empty = executableEvidenceStatuses({ ...files, ...reports });
    expect(executableEvidenceReady(empty)).toBe(false);
    expect(empty.simulation).toMatchObject({ state: "failed", passed: false });
  });
});
