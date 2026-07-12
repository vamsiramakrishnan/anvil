import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import { generateBundle } from "./bundle.js";
import {
  bundleHash,
  CERTIFICATION_FILE,
  type Certification,
  certifyBundle,
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
    expect(bundleHash({ ...files, [CERTIFICATION_FILE]: "{}", "publication.json": "{}" })).toBe(h);
    expect(bundleHash({ ...files, "docs/README.md": "tampered" })).not.toBe(h);
    // Adding or removing a file changes the identity too, not just content edits.
    expect(bundleHash({ ...files, "extra.txt": "x" })).not.toBe(h);
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

  it("fails when air.json no longer validates through the AIR schema", () => {
    const broken = JSON.parse(files["air.json"] as string);
    broken.operations[0].effect.kind = "yolo";
    const cert = certifyBundle({ ...files, "air.json": JSON.stringify(broken) }, air);
    expect(failedIds(cert)).toContain("contract.air-valid");
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
