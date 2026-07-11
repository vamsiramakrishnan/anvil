import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCertify } from "./commands/certify.js";
import { runPublish } from "./commands/publish.js";
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

  it("publishes a certified bundle and writes a publication record", () => {
    certify();
    const io = bufferIO();
    const code = runPublish(dir, { target: "cloud-run", env: "prod" }, io, {
      env: noEnv,
      now: clock("2026-07-10T01:00:00Z"),
    });
    expect(code).toBe(0);
    expect(io.text()).toContain("Deployment plan for 'prod'");
    const record = JSON.parse(readFileSync(join(dir, "publication.json"), "utf8"));
    expect(record.certification.status).toBe("passed");
    expect(record.env).toBe("prod");
    expect(record.target).toBe("cloud-run");
  });

  it("--allow-uncertified waives the gate for dev, recording the waiver", () => {
    const io = bufferIO();
    const code = runPublish(dir, { target: "cloud-run", env: "dev", allowUncertified: true }, io, {
      env: noEnv,
      now: clock("2026-07-10T01:00:00Z"),
    });
    expect(code).toBe(0);
    expect(io.text()).toMatch(/WARNING/);
    const record = JSON.parse(readFileSync(join(dir, "publication.json"), "utf8"));
    expect(record.certification.status).toBe("waived");
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
});
