import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import {
  bundleHash,
  generateBundle,
  readBundleDir,
  verifyCertification,
  writeBundle,
} from "@anvil/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { runCertify } from "./commands/certify.js";
import { runConformanceCommand } from "./commands/conformance.js";
import { runPublish } from "./commands/publish.js";
import { runSelftest } from "./commands/selftest.js";
import { runSimulate } from "./commands/simulate.js";
import { buildStatusReport } from "./commands/status.js";
import { bufferIO } from "./io.js";

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

/** A fresh compiled payments bundle per test, so tampering never leaks across tests. */
let dir: string;
beforeEach(async () => {
  const air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
  dir = mkdtempSync(join(tmpdir(), "anvil-certify-"));
  writeBundle(dir, generateBundle(air));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const clock = (iso: string) => () => iso;
// Publish tests pin the ambient env so a developer's ANVIL_ENV cannot flip outcomes.
const noEnv = {} as NodeJS.ProcessEnv;

const certify = (io = bufferIO(), now = clock("2026-07-10T00:00:00Z")) => ({
  code: runCertify(dir, {}, io, { now }),
  io,
});

function writePassingExecutableEvidence(bundle = dir): void {
  const subject = bundleHash(readBundleDir(bundle));
  writeFileSync(
    join(bundle, "selftest.report.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      bundleHash: subject,
      summary: { pass: 9, fail: 0, skipped: 1 },
    })}\n`,
  );
  writeFileSync(
    join(bundle, "conformance.report.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      bundleHash: subject,
      summary: { pass: 11, fail: 0, skipped: 0 },
    })}\n`,
  );
  writeFileSync(
    join(bundle, "simulation.report.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      bundleHash: subject,
      summary: {
        coverageCells: 35,
        coveragePassed: 35,
        mutantsKilled: 4,
        ok: true,
      },
    })}\n`,
  );
}

describe("anvil certify", () => {
  it("passes a clean payments bundle and writes certification.json", () => {
    const { code, io } = certify();
    expect(code).toBe(0);
    expect(io.text()).toMatch(/contract\s+pass/);
    expect(io.text()).toMatch(/safety\s+pass/);
    expect(io.text()).toMatch(/semantic\s+pass/);
    expect(io.text()).toMatch(/runtime\s+pass/);
    const cert = JSON.parse(readFileSync(join(dir, "certification.json"), "utf8"));
    expect(cert.status).toBe("passed");
    expect(cert.schemaVersion).toBe(1);
    expect(cert.assuranceLevel).toBe("static");
    expect(cert.assurance).toMatchObject({
      level: "static",
      engine: "@anvil/certification",
      engineStatus: "static_passed",
    });
    expect(io.text()).toContain("No generated surface was executed");
  });

  it("re-certifying an unchanged bundle reproduces the certification (minus certifiedAt)", () => {
    certify(bufferIO(), clock("2026-07-10T00:00:00Z"));
    const first = JSON.parse(readFileSync(join(dir, "certification.json"), "utf8"));
    certify(bufferIO(), clock("2026-07-12T09:00:00Z"));
    const second = JSON.parse(readFileSync(join(dir, "certification.json"), "utf8"));
    const { certifiedAt: _a, ...restFirst } = first;
    const { certifiedAt: _b, ...restSecond } = second;
    expect(restSecond).toEqual(restFirst);
  });

  it("fails the contract gate when the CLI and MCP surfaces disagree", () => {
    // Tamper one artifact only: the catalog claims a different CLI command.
    const catalogPath = join(dir, "catalog.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    const refund = catalog.operations.find(
      (o: { id: string }) => o.id === "payments.refunds.create",
    );
    refund.cli = "payments refunds obliterate";
    writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), "utf8");

    const io = bufferIO();
    expect(runCertify(dir, {}, io)).toBe(1);
    expect(io.text()).toMatch(/contract\s+FAIL/);
    expect(io.text()).toContain("contract.surfaces-agree");
  });

  it("fails the safety gate when a mutation loses its confirmation in the runtime manifest", () => {
    const manifestPath = join(dir, "runtime/operations.manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const refund = manifest.operations.find(
      (o: { id: string }) => o.id === "payments.refunds.create",
    );
    refund.confirmation.required = false;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const io = bufferIO();
    expect(runCertify(dir, {}, io)).toBe(1);
    expect(io.text()).toMatch(/safety\s+FAIL/);
    expect(io.text()).toContain("safety.confirmation-required");
  });

  it("accepts the air.yaml path as the bundle coordinate and supports --json", () => {
    const io = bufferIO();
    expect(runCertify(join(dir, "air.yaml"), { json: true }, io)).toBe(0);
    const cert = JSON.parse(io.stdout.join("\n"));
    expect(cert.checks.length).toBeGreaterThan(0);
  });
});

describe("anvil publish (gated)", () => {
  it("refuses an uncertified bundle", () => {
    const io = bufferIO();
    const code = runPublish(dir, { target: "cloud-run", env: "dev" }, io, { env: noEnv });
    expect(code).toBe(1);
    expect(io.text()).toMatch(/anvil certify/);
  });

  it("prepares a certified deployment plan and writes an honest plan record", () => {
    certify();
    writePassingExecutableEvidence();
    const io = bufferIO();
    const code = runPublish(dir, { env: "prod" }, io, {
      env: noEnv,
      now: clock("2026-07-10T01:00:00Z"),
    });
    expect(code).toBe(0);
    expect(io.text()).toContain("Deployment plan only for 'prod'");
    expect(io.text()).toContain("No cloud call was made");
    expect(io.text()).not.toMatch(/^Published /m);
    const record = JSON.parse(readFileSync(join(dir, "publication.json"), "utf8"));
    expect(record.schemaVersion).toBe(2);
    expect(record.certification.status).toBe("passed");
    expect(record.certification.assuranceLevel).toBe("static");
    expect(record.executableEvidence.status).toBe("passed");
    expect(record.executableEvidence.records.selftest).toMatchObject({
      state: "fresh",
      fresh: true,
      passed: true,
      bundleHash: record.bundleHash,
    });
    expect(record.env).toBe("prod");
    expect(record.target).toBe("cloud-run");
    expect(record.recordKind).toBe("deployment_plan");
    expect(record.plannedAt).toBe("2026-07-10T01:00:00Z");
    expect(record.publishedAt).toBeUndefined();
    expect(record.cloudCallsMade).toBe(false);
    expect(record.operatorActionRequired).toBe(true);
  });

  it("defaults the sole publish target to cloud-run at the CLI boundary", async () => {
    certify();
    writePassingExecutableEvidence();
    const io = bufferIO();
    expect(await runAnvilCli(["publish", dir, "--env", "dev"], { io }), io.text()).toBe(0);
    expect(io.text()).toContain("Deployment plan prepared");
    expect(JSON.parse(readFileSync(join(dir, "publication.json"), "utf8")).target).toBe(
      "cloud-run",
    );
  });

  it("--allow-uncertified waives the gate for dev, recording the waiver", () => {
    writePassingExecutableEvidence();
    const io = bufferIO();
    const code = runPublish(dir, { target: "cloud-run", env: "dev", allowUncertified: true }, io, {
      env: noEnv,
      now: clock("2026-07-10T01:00:00Z"),
    });
    expect(code).toBe(0);
    expect(io.text()).toMatch(/WARNING/);
    const record = JSON.parse(readFileSync(join(dir, "publication.json"), "utf8"));
    expect(record.certification.status).toBe("waived");
    expect(record.executableEvidence.status).toBe("passed");
  });

  it("refuses a plan when executable reports are missing", () => {
    certify();
    const io = bufferIO();
    expect(runPublish(dir, { env: "dev" }, io, { env: noEnv })).toBe(1);
    expect(io.text()).toContain("executable evidence is incomplete");
    expect(io.text()).toContain("selftest");
    expect(io.text()).toContain("--allow-incomplete-evidence");
  });

  it("refuses a passing executable report that belongs to an older bundle digest", () => {
    certify();
    writePassingExecutableEvidence();
    const conformancePath = join(dir, "conformance.report.json");
    const conformance = JSON.parse(readFileSync(conformancePath, "utf8"));
    conformance.bundleHash = "0".repeat(64);
    writeFileSync(conformancePath, JSON.stringify(conformance));
    const io = bufferIO();
    expect(runPublish(dir, { env: "dev" }, io, { env: noEnv })).toBe(1);
    expect(io.text()).toContain("conformance.report.json is stale");
  });

  it("--allow-incomplete-evidence waives executable proof for dev and records the waiver", () => {
    certify();
    const io = bufferIO();
    expect(
      runPublish(dir, { env: "dev", allowIncompleteEvidence: true }, io, {
        env: noEnv,
        now: clock("2026-07-10T01:00:00Z"),
      }),
      io.text(),
    ).toBe(0);
    expect(io.text()).toContain("EXECUTABLE EVIDENCE WAIVED");
    const record = JSON.parse(readFileSync(join(dir, "publication.json"), "utf8"));
    expect(record.executableEvidence).toMatchObject({
      status: "waived",
      waiver: { flag: "--allow-incomplete-evidence" },
      records: {
        selftest: { state: "missing", fresh: false, passed: null },
        conformance: { state: "missing", fresh: false, passed: null },
        simulation: { state: "missing", fresh: false, passed: null },
      },
    });
  });

  it("fails closed for prod even when incomplete executable evidence is explicitly waived", () => {
    certify();
    const io = bufferIO();
    expect(
      runPublish(dir, { env: "prod", allowIncompleteEvidence: true }, io, { env: noEnv }),
    ).toBe(1);
    const structured = io.stderr
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .find((entry) => entry?.error)?.error;
    expect(structured).toMatchObject({
      code: "incomplete_executable_evidence_refused",
      env: "prod",
      allowIncompleteEvidence: true,
    });
    expect(structured.evidence.selftest.state).toBe("missing");
  });

  it("fails closed for prod: --allow-uncertified is refused with a structured error", () => {
    const io = bufferIO();
    const code = runPublish(dir, { target: "cloud-run", env: "prod", allowUncertified: true }, io, {
      env: noEnv,
    });
    expect(code).toBe(1);
    const structured = io.stderr.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    });
    const err = structured.find((e) => e?.error)?.error;
    expect(err?.code).toBe("uncertified_publish_refused");
    expect(err?.env).toBe("prod");
  });

  it("fails closed when ANVIL_ENV=prod even without --env", () => {
    const io = bufferIO();
    const code = runPublish(dir, { target: "cloud-run", allowUncertified: true }, io, {
      env: { ANVIL_ENV: "prod" } as NodeJS.ProcessEnv,
    });
    expect(code).toBe(1);
    expect(io.text()).toContain("uncertified_publish_refused");
  });

  it("refuses an unknown ANVIL_ENV instead of treating it as a waivable non-prod environment", () => {
    const io = bufferIO();
    const code = runPublish(dir, { allowUncertified: true, allowIncompleteEvidence: true }, io, {
      env: { ANVIL_ENV: "production" } as NodeJS.ProcessEnv,
    });
    expect(code).toBe(1);
    expect(io.text()).toContain("invalid_deployment_environment");
    expect(io.text()).toContain("dev, staging, or prod");
    expect(existsSync(join(dir, "publication.json"))).toBe(false);
  });

  it("invalidates publish when the bundle is tampered after certification", () => {
    certify();
    writeFileSync(join(dir, "docs/README.md"), "tampered after certification", "utf8");
    const io = bufferIO();
    const code = runPublish(dir, { target: "cloud-run", env: "prod" }, io, { env: noEnv });
    expect(code).toBe(1);
    expect(io.text()).toMatch(/stale/);
  });

  it("a publish record does not invalidate the certification it was gated by", () => {
    certify();
    writePassingExecutableEvidence();
    const first = runPublish(dir, { target: "cloud-run", env: "dev" }, bufferIO(), {
      env: noEnv,
    });
    expect(first).toBe(0);
    // publication.json is a record *about* the bundle, excluded from its identity,
    // so publishing again (e.g. to another env) still sees a valid certification.
    const second = runPublish(dir, { target: "cloud-run", env: "prod" }, bufferIO(), {
      env: noEnv,
    });
    expect(second).toBe(0);
  });

  it("reads legacy schema-v1 publication records as plans, never as completed deploys", async () => {
    certify();
    writePassingExecutableEvidence();
    const subject = bundleHash(readBundleDir(dir));
    writeFileSync(
      join(dir, "publication.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          serviceId: "payments",
          target: "cloud-run",
          env: "dev",
          bundleHash: subject,
          certification: {
            status: "passed",
            certifiedAt: "2026-07-10T00:00:00Z",
          },
          publishedAt: "2026-07-10T01:00:00Z",
          artifacts: ["deploy/Dockerfile"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const status = await buildStatusReport(dir);
    expect(status.publication.state).toBe("planned");
    expect(status.publication.plannedAt).toBe("2026-07-10T01:00:00Z");
    expect(status.publication.publishedAt).toBe("2026-07-10T01:00:00Z");
    expect(status.publication.cloudCallsMade).toBe(false);
    expect(status.publication.executableEvidenceGate).toBe("unrecorded");
    expect(status.nextAction.code).toBe("operator-action-required");
  });

  it("fails closed when a schema-v2 plan omits its executable-evidence snapshot", async () => {
    certify();
    writePassingExecutableEvidence();
    expect(
      runPublish(dir, { env: "dev" }, bufferIO(), {
        env: noEnv,
        now: clock("2026-07-10T01:00:00Z"),
      }),
    ).toBe(0);
    const path = join(dir, "publication.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    delete record.executableEvidence;
    writeFileSync(path, JSON.stringify(record));

    const status = await buildStatusReport(dir);
    expect(status.publication).toMatchObject({
      state: "corrupt",
      executableEvidenceGate: null,
    });
    expect(status.diagnostics).toContainEqual(
      expect.objectContaining({ code: "status.publication.corrupt" }),
    );
    expect(status.nextAction.code).toBe("release");
  });

  it("rejects a tampered production plan that carries non-production waivers", async () => {
    expect(
      runPublish(
        dir,
        {
          env: "dev",
          allowUncertified: true,
          allowIncompleteEvidence: true,
        },
        bufferIO(),
        { env: noEnv },
      ),
    ).toBe(0);
    const path = join(dir, "publication.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.env = "prod";
    writeFileSync(path, JSON.stringify(record));

    const status = await buildStatusReport(dir);
    expect(status.publication.state).toBe("corrupt");
    expect(status.nextAction.code).toBe("certify");
  });

  it("fails closed when a passed plan snapshot names a different bundle digest", async () => {
    certify();
    writePassingExecutableEvidence();
    expect(runPublish(dir, { env: "dev" }, bufferIO(), { env: noEnv })).toBe(0);
    const path = join(dir, "publication.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.executableEvidence.records.selftest.bundleHash = "0".repeat(64);
    writeFileSync(path, JSON.stringify(record));

    const status = await buildStatusReport(dir);
    expect(status.publication.state).toBe("corrupt");
    expect(status.nextAction.code).toBe("release");
  });

  it("fails closed when keyed plan evidence swaps its lane or report file", async () => {
    certify();
    writePassingExecutableEvidence();
    expect(runPublish(dir, { env: "dev" }, bufferIO(), { env: noEnv })).toBe(0);
    const path = join(dir, "publication.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.executableEvidence.records.selftest.lane = "conformance";
    record.executableEvidence.records.selftest.file = "conformance.report.json";
    writeFileSync(path, JSON.stringify(record));

    const status = await buildStatusReport(dir);
    expect(status.publication.state).toBe("corrupt");
    expect(status.nextAction.code).toBe("release");
  });

  it("keeps one subject digest through static assurance, executable evidence, and release planning", async () => {
    const subject = bundleHash(readBundleDir(dir));
    expect(certify().code).toBe(0);
    expect(verifyCertification(readBundleDir(dir)).ok).toBe(true);

    const selftest = bufferIO();
    expect(await runSelftest(dir, {}, selftest), selftest.text()).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "selftest.report.json"), "utf8")).bundleHash).toBe(
      subject,
    );
    expect(verifyCertification(readBundleDir(dir)).ok).toBe(true);

    const conformance = bufferIO();
    expect(await runConformanceCommand(dir, {}, conformance), conformance.text()).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "conformance.report.json"), "utf8")).bundleHash).toBe(
      subject,
    );
    expect(verifyCertification(readBundleDir(dir)).ok).toBe(true);

    const simulation = bufferIO();
    expect(runSimulate(dir, {}, simulation), simulation.text()).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "simulation.report.json"), "utf8")).bundleHash).toBe(
      subject,
    );
    expect(verifyCertification(readBundleDir(dir)).ok).toBe(true);

    const plan = bufferIO();
    expect(
      runPublish(dir, { env: "dev" }, plan, {
        env: noEnv,
        now: clock("2026-07-10T01:00:00Z"),
      }),
      plan.text(),
    ).toBe(0);
    expect(verifyCertification(readBundleDir(dir)).ok).toBe(true);

    const status = await buildStatusReport(dir);
    expect(status.core.bundleHash).toBe(subject);
    expect(status.executableEvidence.selftest).toMatchObject({
      state: "fresh",
      fresh: true,
      passed: true,
      bundleHash: subject,
    });
    expect(status.executableEvidence.conformance.state).toBe("fresh");
    expect(status.executableEvidence.simulation.state).toBe("fresh");
    expect(status.publication.state).toBe("planned");
    expect(status.publication.executableEvidenceGate).toBe("passed");
    expect(status.nextAction.code).toBe("operator-action-required");
  }, 60_000);
});
