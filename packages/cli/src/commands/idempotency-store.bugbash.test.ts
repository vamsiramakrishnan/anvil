import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { compile } from "@anvil/compiler";
import {
  bundleHash,
  type Certification,
  certifyBundle,
  generateBundle,
  IDEMPOTENCY_STORE_CONTRACT_FILE,
  readBundleDir,
  writeBundle,
} from "@anvil/generators";
import { DEFAULT_LEDGER_RESULT_TTL_SECONDS } from "@anvil/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";
import { inspectIdempotencyStore, runDeployLedger } from "./idempotency-store.js";

/**
 * `anvil deploy ledger` / `inspectIdempotencyStore` — this file has zero
 * dedicated coverage: packages/cli/src/cmd-deploy.test.ts only ever compiles
 * the `payments` example, whose only mutation with idempotency mode
 * `required` (createRefund) forces `contract.backend === "firestore"` on
 * every single test. The `backend === "none"` branch (`renderNoStore` and the
 * early return that skips it) — reachable whenever no *approved* mutation
 * requires an explicit idempotency key — is entirely untested there. This
 * file targets that gap, plus direct unit coverage of `inspectIdempotencyStore`'s
 * missing/corrupt/stale/fresh branches (including the certification-binding
 * checks that are hard to reach through a compiled CLI round-trip), option
 * validation edge cases, and the read-only/no-cloud-call safety posture the
 * command promises.
 */

const examples = fileURLToPath(new URL("../../../../examples/payments/", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

const dirs: string[] = [];
function freshDir(prefix = "anvil-bugbash-idempotency-store-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The stock `payments` AIR: createRefund is an approved mutation with
 * idempotency mode `required` (drives `backend: "firestore"`); capturePayment
 * is an approved mutation with idempotency mode `natural` (never drives a
 * managed store on its own).
 */
async function paymentsAir(): Promise<AirDocument> {
  return compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
}

/** Same surface, but the one required-key mutation is no longer approved: backend "none". */
function withoutApprovedLedgerWrite(air: AirDocument): AirDocument {
  const clone = structuredClone(air);
  const refund = clone.operations.find((op) => op.id === "payments.refunds.create");
  if (!refund) throw new Error("fixture AIR is missing payments.refunds.create");
  refund.state = "blocked";
  return clone;
}

/** Same surface, but every mutation is unapproved: backend "none" and writes === []. */
function withNoApprovedMutations(air: AirDocument): AirDocument {
  const clone = structuredClone(air);
  for (const op of clone.operations) {
    if (op.effect.kind === "mutation") op.state = "blocked";
  }
  return clone;
}

async function writeRealBundle(air: AirDocument): Promise<string> {
  const dir = freshDir();
  writeBundle(dir, generateBundle(air));
  return dir;
}

describe("inspectIdempotencyStore — missing, corrupt, stale, fresh", () => {
  it("reports missing when deploy/idempotency-store.json is absent from the file map", async () => {
    const air = await paymentsAir();
    const { files } = generateBundle(air);
    const { [IDEMPOTENCY_STORE_CONTRACT_FILE]: _dropped, ...withoutContract } = files;
    const inspection = inspectIdempotencyStore(air, "/bundle", withoutContract);
    expect(inspection.state).toBe("missing");
    expect(inspection.stored).toBeNull();
    expect(inspection.detail).toBe(
      `${IDEMPOTENCY_STORE_CONTRACT_FILE} is missing; recompile the bundle.`,
    );
    expect(inspection.path).toBe(join("/bundle", IDEMPOTENCY_STORE_CONTRACT_FILE));
  });

  it("reports corrupt for syntactically invalid JSON, distinct from a schema mismatch", async () => {
    const air = await paymentsAir();
    const { files } = generateBundle(air);
    const inspection = inspectIdempotencyStore(air, "/bundle", {
      ...files,
      [IDEMPOTENCY_STORE_CONTRACT_FILE]: "{not json",
    });
    expect(inspection.state).toBe("corrupt");
    expect(inspection.stored).toBeNull();
    expect(inspection.detail).toBe(`${IDEMPOTENCY_STORE_CONTRACT_FILE} is not valid JSON.`);
  });

  it("reports corrupt for well-formed JSON that fails the store-contract schema", async () => {
    const air = await paymentsAir();
    const { files } = generateBundle(air);
    const inspection = inspectIdempotencyStore(air, "/bundle", {
      ...files,
      [IDEMPOTENCY_STORE_CONTRACT_FILE]: JSON.stringify({ hello: "world" }),
    });
    expect(inspection.state).toBe("corrupt");
    expect(inspection.detail).toBe(
      `${IDEMPOTENCY_STORE_CONTRACT_FILE} does not match schema version 1.`,
    );
  });

  it("reports stale when the stored contract is schema-valid but no longer matches canonical AIR", async () => {
    const air = await paymentsAir();
    const { files } = generateBundle(air);
    const stored = JSON.parse(files[IDEMPOTENCY_STORE_CONTRACT_FILE] as string);
    stored.firestore.namespace = "forged-namespace";
    const inspection = inspectIdempotencyStore(air, "/bundle", {
      ...files,
      [IDEMPOTENCY_STORE_CONTRACT_FILE]: JSON.stringify(stored),
    });
    expect(inspection.state).toBe("stale");
    expect(inspection.stored).not.toBeNull();
    expect(inspection.detail).toContain("does not match canonical AIR");
    expect(inspection.detail).toContain("recompile before planning or proving ledger readiness");
  });

  it("is fresh for an unmodified compiled firestore-backed bundle, with a Firestore-specific detail", async () => {
    const air = await paymentsAir();
    const { files } = generateBundle(air);
    const inspection = inspectIdempotencyStore(air, "/bundle", files);
    expect(inspection.state).toBe("fresh");
    expect(inspection.expected.backend).toBe("firestore");
    expect(inspection.detail).toContain(
      "The generated Firestore store contract and every compiler-owned bundle byte match",
    );
  });

  it("is fresh for an unmodified compiled bundle that needs no managed store, with a distinct detail", async () => {
    const air = withoutApprovedLedgerWrite(await paymentsAir());
    const { files } = generateBundle(air);
    const inspection = inspectIdempotencyStore(air, "/bundle", files);
    expect(inspection.state).toBe("fresh");
    expect(inspection.expected.backend).toBe("none");
    expect(inspection.detail).toBe(
      "Canonical AIR does not require a managed idempotency store, and every compiler-owned bundle byte matches its deterministic projection.",
    );
  });

  it("goes stale when the supplied certification's bundleHash no longer binds these bytes", async () => {
    const air = await paymentsAir();
    const { files } = generateBundle(air);
    const goodCert = certifyBundle({ ...files }, air);
    expect(goodCert.status).toBe("passed"); // sanity: fixture certifies cleanly before we corrupt it
    const forged: Certification = { ...goodCert, bundleHash: "0".repeat(64) };
    const inspection = inspectIdempotencyStore(air, "/bundle", files, forged);
    expect(inspection.state).toBe("stale");
    expect(inspection.detail).toContain("does not bind the current bundle hash");
  });

  it("goes stale when the certification carries no contract.generated-bytes-agree check at all", async () => {
    const air = await paymentsAir();
    const { files } = generateBundle(air);
    const goodCert = certifyBundle({ ...files }, air);
    const withoutCheck: Certification = {
      ...goodCert,
      checks: goodCert.checks.filter((check) => check.id !== "contract.generated-bytes-agree"),
    };
    const inspection = inspectIdempotencyStore(air, "/bundle", files, withoutCheck);
    expect(inspection.state).toBe("stale");
    expect(inspection.detail).toBe(
      "The compiler-owned generated-byte check is missing; recompile before planning or proving ledger readiness.",
    );
  });

  it("goes stale and surfaces the check's own detail when contract.generated-bytes-agree failed", async () => {
    const air = await paymentsAir();
    const { files } = generateBundle(air);
    const goodCert = certifyBundle({ ...files }, air);
    const failing: Certification = {
      ...goodCert,
      checks: goodCert.checks.map((check) =>
        check.id === "contract.generated-bytes-agree"
          ? { ...check, status: "failed" as const, detail: "synthetic drift injected by the test" }
          : check,
      ),
    };
    const inspection = inspectIdempotencyStore(air, "/bundle", files, failing);
    expect(inspection.state).toBe("stale");
    expect(inspection.detail).toBe("synthetic drift injected by the test");
  });
});

describe("runDeployLedger — bundle-loading failures", () => {
  it("returns 1 with a plain error, not a stack trace, when no air.yaml or air.json exists", async () => {
    const dir = freshDir();
    const io = bufferIO();
    const code = await runDeployLedger(dir, {}, io);
    expect(code).toBe(1);
    expect(io.stderr).toEqual([`No air.yaml or air.json in ${dir}.`]);
    expect(io.stdout).toEqual([]);
  });

  it("returns 1 when the dir argument does not exist as a directory or a file", async () => {
    const missing = join(freshDir(), "does-not-exist");
    const io = bufferIO();
    const code = await runDeployLedger(missing, {}, io);
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("ENOENT");
  });

  it("returns 1 when readBundleDir refuses a symlink inside the bundle", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    symlinkSync(join(dir, "air.yaml"), join(dir, "sneaky-link"));
    const io = bufferIO();
    const code = await runDeployLedger(dir, {}, io);
    expect(code).toBe(1);
    expect(io.stderr).toEqual([
      "Unexpected symlink in bundle at sneaky-link; certification cannot bind external or mutable link targets.",
    ]);
  });

  it("accepts a direct path to air.yaml, not just the bundle directory", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const code = await runDeployLedger(join(dir, "air.yaml"), {}, io);
    expect(code).toBe(0);
    expect(io.stdout.join("\n")).toContain("Idempotency write plan — payments");
  });

  it("returns 1 (not fresh) when deploy/idempotency-store.json is missing from an ad-hoc directory", async () => {
    // A directory holding only air.yaml (never run through generateBundle/writeBundle) has no
    // deploy/ tree at all, so the contract inspection must report "missing", not throw.
    const dir = freshDir();
    const { files } = generateBundle(await paymentsAir());
    writeFileSync(join(dir, "air.yaml"), files["air.yaml"] as string);
    const io = bufferIO();
    const code = await runDeployLedger(dir, {}, io);
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("Idempotency store contract is missing:");
    expect(io.stderr.join("\n")).toContain("recompile the bundle");
  });

  it("returns 1 (stale) when deploy/idempotency-store.json is hand-edited after compile", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const path = join(dir, IDEMPOTENCY_STORE_CONTRACT_FILE);
    const contract = JSON.parse(readFileSync(path, "utf8"));
    contract.firestore.namespace = "tampered";
    writeFileSync(path, JSON.stringify(contract, null, 2));
    const io = bufferIO();
    const code = await runDeployLedger(dir, {}, io);
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("Idempotency store contract is stale:");
  });

  it("returns 1 (corrupt) when deploy/idempotency-store.json is not valid JSON", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const path = join(dir, IDEMPOTENCY_STORE_CONTRACT_FILE);
    writeFileSync(path, "{not json");
    const io = bufferIO();
    const code = await runDeployLedger(dir, {}, io);
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("Idempotency store contract is corrupt:");
  });
});

describe("runDeployLedger — option validation runs before touching the filesystem", () => {
  const bogusDir = "/nonexistent-on-purpose/anvil-bugbash";

  it("rejects --json combined with --tfvars", async () => {
    const io = bufferIO();
    const code = await runDeployLedger(bogusDir, { json: true, tfvars: true }, io);
    expect(code).toBe(1);
    expect(io.stderr).toEqual(["Choose either --json or --tfvars, not both."]);
  });

  it("rejects a --database-mode outside shared/dedicated", async () => {
    const io = bufferIO();
    // Commander hands the action an untyped string at runtime even though the
    // exported option type narrows it to "shared" | "dedicated"; validate the
    // way a real CLI invocation with a bogus value would actually behave.
    const code = await runDeployLedger(
      bogusDir,
      { databaseMode: "spanner" as unknown as "dedicated" },
      io,
    );
    expect(code).toBe(1);
    expect(io.stderr).toEqual(["Invalid --database-mode: expected shared or dedicated."]);
  });

  it("rejects a malformed --project before ever resolving the bundle", async () => {
    const io = bufferIO();
    const code = await runDeployLedger(bogusDir, { project: "UPPER_CASE_NOT_ALLOWED" }, io);
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("Invalid --project");
  });

  it("rejects a too-short --project", async () => {
    const io = bufferIO();
    const code = await runDeployLedger(bogusDir, { project: "ab1" }, io);
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("Invalid --project");
  });

  it("rejects a malformed --database", async () => {
    const io = bufferIO();
    const code = await runDeployLedger(bogusDir, { database: "x" }, io);
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("Invalid --database");
  });

  it("accepts the literal (default) database id as a valid format, failing later on the bundle instead", async () => {
    // (default) is the one exception isFirestoreDatabaseId allows outside its regex; this only
    // proves validateLedgerOptions doesn't reject it — the error below comes from loadAir, not
    // from the --database format check.
    const io = bufferIO();
    const code = await runDeployLedger(bogusDir, { database: "(default)" }, io);
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).not.toContain("Invalid --database");
    expect(io.stderr.join("\n")).toContain("ENOENT");
  });

  it("rejects a malformed --location", async () => {
    const io = bufferIO();
    const code = await runDeployLedger(bogusDir, { location: "US_EAST" }, io);
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("Invalid --location");
  });

  it("passes valid option formats through to bundle resolution (which then fails on the missing path)", async () => {
    const io = bufferIO();
    const code = await runDeployLedger(
      bogusDir,
      { project: "acme-prod-1", database: "trust-ledger", location: "nam5" },
      io,
    );
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("ENOENT");
  });
});

describe("runDeployLedger — backend none (renderNoStore): entirely uncovered elsewhere in this package", () => {
  it("prints the no-store human report, including approved writes and the safety-contract line", async () => {
    const dir = await writeRealBundle(withoutApprovedLedgerWrite(await paymentsAir()));
    const io = bufferIO();
    const code = await runDeployLedger(dir, {}, io);
    expect(code).toBe(0);
    const output = io.stdout.join("\n");
    expect(output).toContain("Idempotency write plan — payments");
    // capturePayment (natural mode) is still approved and still listed, even though no store is needed.
    expect(output).toContain("payments.capture.create");
    expect(output).not.toContain("payments.refunds.create"); // blocked, so excluded from writes
    expect(output).toContain("Managed store — NOT REQUIRED");
    expect(output).toContain(
      "No approved mutation has idempotency mode `required`; this Terraform projection omits ledger resources and runtime IAM, and sets ANVIL_LEDGER to an explicit empty value.",
    );
    expect(output).toContain("ABANDON preserves replay evidence, TTL, and index policy");
    expect(output).toContain(
      "This does not make non-idempotent writes safe: `none` remains non-retryable, and approval/confirmation still apply.",
    );
    expect(output).toContain("No cloud call was made.");
    expect(io.stderr).toEqual([]);
  });

  it("prints '(none)' for approved writes when nothing at all is approved", async () => {
    const dir = await writeRealBundle(withNoApprovedMutations(await paymentsAir()));
    const io = bufferIO();
    const code = await runDeployLedger(dir, {}, io);
    expect(code).toBe(0);
    const output = io.stdout.join("\n");
    expect(output).toContain("Approved writes — 0");
    expect(output).toContain("  (none)");
    expect(output).toContain("Managed store — NOT REQUIRED");
  });

  it("emits {} for --tfvars, ignoring project/database entirely (unlike the firestore path)", async () => {
    const dir = await writeRealBundle(withoutApprovedLedgerWrite(await paymentsAir()));
    const io = bufferIO();
    const code = await runDeployLedger(dir, { tfvars: true }, io);
    expect(code).toBe(0);
    expect(io.stdout).toEqual(["{}"]);
  });

  it("emits a machine-readable report for --json with backend none and no store digest field", async () => {
    const dir = await writeRealBundle(withoutApprovedLedgerWrite(await paymentsAir()));
    const io = bufferIO();
    const code = await runDeployLedger(dir, { json: true }, io);
    expect(code).toBe(0);
    const report = JSON.parse(io.stdout.join("\n")) as {
      schemaVersion: number;
      serviceId: string;
      contract: { state: string; required: boolean; backend: string; digest?: string };
      writes: Array<{ id: string; managedStoreRequired: boolean }>;
      staticWiring: { state: string };
      liveReadiness: { state: string; detail: string };
      cloudCallsMade: boolean;
    };
    expect(report.contract).toMatchObject({ state: "fresh", required: false, backend: "none" });
    expect(report.contract).not.toHaveProperty("digest");
    expect(report.writes).toHaveLength(1);
    expect(report.writes[0]).toMatchObject({
      id: "payments.capture.create",
      managedStoreRequired: false,
    });
    expect(report.liveReadiness).toEqual({
      state: "not-required",
      detail: "No approved mutation requires the managed idempotency store.",
    });
    expect(report.cloudCallsMade).toBe(false);
  });

  it("short-circuits before ttl/database-mode validation: a backend-none bundle ignores those flags entirely", async () => {
    // Documents current behavior: because `contract.backend === "none"` returns before the
    // ttl-seconds parse and the dedicated/shared database-mode checks run, flags that would be
    // rejected outright on a firestore-backed bundle are silently accepted (and ignored) here.
    const dir = await writeRealBundle(withoutApprovedLedgerWrite(await paymentsAir()));
    const io = bufferIO();
    const code = await runDeployLedger(
      dir,
      { ttlSeconds: "not-a-number", databaseMode: "dedicated" },
      io,
    );
    expect(code).toBe(0);
    expect(io.stderr).toEqual([]);
  });
});

describe("runDeployLedger — firestore path: ttl-seconds boundaries", () => {
  it("defaults to the compiler's resultTtlSecondsDefault when --ttl-seconds is omitted", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const code = await runDeployLedger(dir, { json: true }, io);
    expect(code).toBe(0);
    const report = JSON.parse(io.stdout.join("\n"));
    expect(report.guarantees.completedReplayRetentionSeconds).toBe(
      DEFAULT_LEDGER_RESULT_TTL_SECONDS,
    );
  });

  it("rejects a non-numeric --ttl-seconds", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const code = await runDeployLedger(dir, { ttlSeconds: "soon" }, io);
    expect(code).toBe(1);
    expect(io.stderr).toEqual(["--ttl-seconds must be an integer from 60 to 31536000."]);
  });

  it("rejects a negative --ttl-seconds (fails the digits-only regex)", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const code = await runDeployLedger(dir, { ttlSeconds: "-60" }, io);
    expect(code).toBe(1);
    expect(io.stderr).toEqual(["--ttl-seconds must be an integer from 60 to 31536000."]);
  });

  it("rejects one second below the floor (59)", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const code = await runDeployLedger(dir, { ttlSeconds: "59" }, io);
    expect(code).toBe(1);
  });

  it("accepts exactly the floor (60)", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const code = await runDeployLedger(dir, { ttlSeconds: "60", json: true }, io);
    expect(code).toBe(0);
    expect(JSON.parse(io.stdout.join("\n")).guarantees.completedReplayRetentionSeconds).toBe(60);
  });

  it("accepts exactly the ceiling (31536000)", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const code = await runDeployLedger(dir, { ttlSeconds: "31536000", json: true }, io);
    expect(code).toBe(0);
    expect(JSON.parse(io.stdout.join("\n")).guarantees.completedReplayRetentionSeconds).toBe(
      31536000,
    );
  });

  it("rejects one second above the ceiling (31536001)", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const code = await runDeployLedger(dir, { ttlSeconds: "31536001" }, io);
    expect(code).toBe(1);
  });
});

describe("runDeployLedger — firestore path: database-mode / location combinations", () => {
  it("refuses dedicated mode with the literal (default) database id", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const code = await runDeployLedger(
      dir,
      { databaseMode: "dedicated", database: "(default)", location: "nam5" },
      io,
    );
    expect(code).toBe(1);
    expect(io.stderr).toEqual(["Dedicated mode requires a named --database id, not (default)."]);
  });

  it("refuses dedicated mode with no --database at all", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const code = await runDeployLedger(dir, { databaseMode: "dedicated", location: "nam5" }, io);
    expect(code).toBe(1);
    expect(io.stderr).toEqual([
      "Dedicated mode requires --database so Terraform can create the exact named database.",
    ]);
  });

  it("refuses dedicated mode with no --location", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const code = await runDeployLedger(
      dir,
      { databaseMode: "dedicated", database: "ledger-1" },
      io,
    );
    expect(code).toBe(1);
    expect(io.stderr).toEqual([
      "Dedicated mode requires --location because a Firestore database location is immutable after creation.",
    ]);
  });

  it("refuses shared mode combined with --location", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const code = await runDeployLedger(dir, { databaseMode: "shared", location: "nam5" }, io);
    expect(code).toBe(1);
    expect(io.stderr).toEqual([
      "--location is not accepted in shared mode: the platform-owned database already has an immutable location.",
    ]);
  });

  it("prioritizes the ttl-seconds error over an incomplete dedicated-mode request", async () => {
    // ttlSeconds is parsed before the database-mode branch runs, so a bad ttl wins even when the
    // dedicated-mode options are also incomplete.
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const code = await runDeployLedger(dir, { ttlSeconds: "0", databaseMode: "dedicated" }, io);
    expect(code).toBe(1);
    expect(io.stderr).toEqual(["--ttl-seconds must be an integer from 60 to 31536000."]);
  });

  it("requires both --project and --database for --tfvars on a firestore-backed bundle", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const projectOnly = await runDeployLedger(dir, { tfvars: true, project: "acme-prod-1" }, io);
    expect(projectOnly).toBe(1);
    expect(io.stderr).toEqual([
      "--tfvars requires --project and --database so the emitted input has no unresolved store coordinate.",
    ]);
  });

  it("renders shared-mode plan text with the platform-owned-location line, not the immutable-location line", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const code = await runDeployLedger(dir, {}, io);
    expect(code).toBe(0);
    const output = io.stdout.join("\n");
    expect(output).toContain("provisioning mode: shared");
    expect(output).toContain(
      "location: owned by the existing shared database; omit --location (it is accepted only for dedicated mode)",
    );
    expect(output).not.toContain("immutable after first creation");
    expect(output).toContain(
      "decommission: both field policies use ABANDON; runtime IAM/config detaches and the shared database remains platform-owned",
    );
    expect(output).toContain(
      "reintroduction: import only both preserved field policies; never import the shared database into capability state",
    );
  });

  it("renders dedicated-mode plan text with the immutable-location line and dedicated decommission/reintroduction text", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const code = await runDeployLedger(
      dir,
      {
        databaseMode: "dedicated",
        database: "payments-ledger",
        location: "nam5",
        project: "acme-prod-1",
      },
      io,
    );
    expect(code).toBe(0);
    const output = io.stdout.join("\n");
    expect(output).toContain("provisioning mode: dedicated");
    expect(output).toContain("location: nam5 — immutable after first creation");
    expect(output).toContain(
      "decommission: dedicated database + both field policies use ABANDON; runtime IAM/config detaches while evidence and policy remain",
    );
    expect(output).toContain(
      "reintroduction: import the preserved database and both field policies into reviewed Terraform state before apply",
    );
    expect(output).toContain(
      "Before first apply, verify the immutable location is offered: gcloud firestore locations list --project 'acme-prod-1'",
    );
  });

  it("leaves ANVIL_LEDGER unresolved in the plan when --project/--database are omitted", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const code = await runDeployLedger(dir, {}, io);
    expect(code).toBe(0);
    const output = io.stdout.join("\n");
    expect(output).toContain("(pass --project and --database to resolve)");
  });

  it("resolves ANVIL_LEDGER and the reviewed input digest once --project and --database are both given", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const code = await runDeployLedger(
      dir,
      { project: "acme-prod-1", database: "trust-ledger-prod" },
      io,
    );
    expect(code).toBe(0);
    const output = io.stdout.join("\n");
    expect(output).toContain("firestore://acme-prod-1/trust-ledger-prod");
    expect(output).toContain("reviewed input digest:");
    expect(output).not.toContain("reviewed input digest: unresolved");
  });
});

describe("runDeployLedger — firestore path: guarantee/safety text always present (never weakened)", () => {
  it("keeps the non-exactly-once, crash-boundary, and cloud-call guarantees in the human report", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const code = await runDeployLedger(dir, {}, io);
    expect(code).toBe(0);
    const output = io.stdout.join("\n");
    expect(output).toContain("This is not exactly-once execution.");
    expect(output).toContain("stays in_progress for deliberate reconciliation");
    expect(output).toContain("No cloud call was made.");
  });

  it("keeps exactlyOnce:false and cloudCallsMade:false in the JSON report", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const code = await runDeployLedger(dir, { json: true }, io);
    expect(code).toBe(0);
    const report = JSON.parse(io.stdout.join("\n"));
    expect(report.guarantees.exactlyOnce).toBe(false);
    expect(report.cloudCallsMade).toBe(false);
    expect(report.deploymentInput).toMatchObject({ state: "unresolved" });
  });
});

describe("registerDeployLedger — actual CLI wiring (not just the exported function)", () => {
  it("routes `anvil deploy ledger` through the real command tree for the backend-none case", async () => {
    const dir = await writeRealBundle(withoutApprovedLedgerWrite(await paymentsAir()));
    const io = bufferIO();
    const code = await runAnvilCli(["deploy", "ledger", dir], { io });
    expect(code, io.text()).toBe(0);
    expect(io.stdout.join("\n")).toContain("Managed store — NOT REQUIRED");
  });

  it("rejects a bogus --database-mode supplied on the real command line, not just via direct calls", async () => {
    const dir = await writeRealBundle(await paymentsAir());
    const io = bufferIO();
    const code = await runAnvilCli(["deploy", "ledger", dir, "--database-mode", "spanner"], { io });
    expect(code, io.text()).toBe(1);
    expect(io.stderr.join("\n")).toContain(
      "Invalid --database-mode: expected shared or dedicated.",
    );
  });
});

describe("inspectIdempotencyStore / bundleHash — sanity cross-check", () => {
  it("the default certification argument really does recompute bundleHash from the files passed in", async () => {
    // inspectIdempotencyStore's default parameter is `certifyBundle({ ...files }, air)`, evaluated
    // fresh per call — confirm that calling it twice with different (but each internally
    // consistent) file maps never leaks a stale certification between calls.
    const air = await paymentsAir();
    const { files: freshFiles } = generateBundle(air);
    const fresh = inspectIdempotencyStore(air, "/bundle", freshFiles);
    expect(fresh.state).toBe("fresh");

    const tampered = { ...freshFiles, "docs/README.md": "tampered after generation" };
    const stale = inspectIdempotencyStore(air, "/bundle", tampered);
    expect(stale.state).toBe("stale");
    expect(bundleHash(freshFiles)).not.toBe(bundleHash(tampered));
  });
});

describe("readBundleDir + inspectIdempotencyStore — end to end on disk, mirrors runDeployLedger's own plumbing", () => {
  it("agrees with the in-memory generateBundle result once written to and read back from disk", async () => {
    const air = await paymentsAir();
    const dir = await writeRealBundle(air);
    const diskFiles = readBundleDir(dir);
    const inspection = inspectIdempotencyStore(air, dir, diskFiles);
    expect(inspection.state).toBe("fresh");
  });
});
