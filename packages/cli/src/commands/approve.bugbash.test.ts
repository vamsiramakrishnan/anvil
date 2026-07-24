import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AirDocument, airFromYaml, airToYaml } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { generateBundle, readBundleDir, writeBundle } from "@anvil/generators";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";
import { reprojectBundleAtomically, runApprove } from "./approve.js";
import { loadAir } from "./shared.js";

/**
 * `anvil approve` — targeted coverage of packages/cli/src/commands/approve.ts
 * branches that packages/cli/src/cmd-approve.test.ts does not already exercise:
 * bundle-root safety guards (symlink, non-canonical AIR path, incomplete
 * bundle), approval-validation guards (unknown/blocked ids, duplicate ids,
 * already-approved no-ops), the "only approved operations are exposed" safety
 * invariant with confirmation/idempotency/retries preserved verbatim, the
 * immutable gateway-import-lineage refusal (including malformed/invalid
 * receipts), corrupt canonical AIR, and `reprojectBundleAtomically` invoked
 * directly (the seam `commands/capability.ts` also uses).
 */

const examples = fileURLToPath(new URL("../../../../examples/payments/", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "anvil-bugbash-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A compiled payments bundle with no manifest: some operations land in review_required. */
async function paymentsBundle(): Promise<string> {
  const air = await compile({ spec: read("openapi.yaml"), serviceId: "payments" });
  const dir = freshDir();
  writeBundle(dir, generateBundle(air));
  return dir;
}

async function compileWithManifest(manifest: string): Promise<string> {
  const air = await compile({ spec: read("openapi.yaml"), manifest, serviceId: "payments" });
  const dir = freshDir();
  writeBundle(dir, generateBundle(air));
  return dir;
}

function opId(air: AirDocument, sourceOperationId: string): string {
  const op = air.operations.find((o) => o.sourceRef.operationId === sourceOperationId);
  if (!op) throw new Error(`fixture has no operation for ${sourceOperationId}`);
  return op.id;
}

function kongConfig(serviceName: string, path: string): string {
  return `_format_version: "3.0"
services:
  - name: ${serviceName}
    routes:
      - name: ${serviceName}-route
        paths: ["${path}"]
        methods: ["POST"]
    plugins:
      - name: openid-connect
        config:
          scopes: ["refunds:write"]
`;
}

// A route-only Kong export (no --spec) leaves every operation permanently
// "blocked" (missing schema/security proof), which would make `runApprove`
// reject on the blocked-operation guard before it ever reaches the
// receipt-lineage guard this suite targets. Supplying the original contract
// via --spec (mirroring packages/cli/src/cmd-estate.test.ts) resolves the
// route-only concern so the imported operation lands in "review_required"
// instead — pending, but not blocked.
const REFUNDS_POST_OPENAPI = `openapi: "3.0.3"
info: { title: Refunds, version: "1.0.0" }
components:
  securitySchemes:
    enterprise_oidc:
      type: oauth2
      flows:
        clientCredentials:
          tokenUrl: https://idp.example.test/oauth/token
          scopes:
            refunds:write: Write refunds
security:
  - enterprise_oidc: [refunds:write]
paths:
  /refunds:
    post:
      operationId: createRefund
      responses: { "200": { description: ok } }
`;

/** A bundle imported through `anvil estate import`, so import.receipt.json is a real bound receipt view. */
async function importedGatewayBundle(): Promise<{ bundle: string; root: string }> {
  const root = freshDir();
  const gateway = join(root, "kong.yaml");
  const spec = join(root, "refunds.openapi.yaml");
  writeFileSync(gateway, kongConfig("refunds", "/refunds"));
  writeFileSync(spec, REFUNDS_POST_OPENAPI);
  const bundle = join(root, "bundle");
  const io = bufferIO();
  const code = await runAnvilCli(
    [
      "estate",
      "import",
      gateway,
      "--vendor",
      "kong",
      "--spec",
      spec,
      "--gateway-url",
      "https://gateway.example.test",
      "--out",
      bundle,
      "--root",
      root,
    ],
    { io },
  );
  expect(code, io.text()).toBe(0);
  return { bundle, root };
}

describe("anvil approve — bundle-root safety guards", () => {
  it("refuses a symlinked bundle directory", async () => {
    const dir = await paymentsBundle();
    const root = freshDir();
    const link = join(root, "bundle-link");
    symlinkSync(dir, link, "dir");
    const io = bufferIO();
    expect(() => runApprove(link, ["whatever"], io)).toThrow(
      "Approval requires a real compiled bundle directory, not a symlink:",
    );
  });

  it("refuses a non-canonical AIR filename inside a real bundle", async () => {
    const dir = await paymentsBundle();
    const custom = join(dir, "custom.yaml");
    writeFileSync(custom, readFileSync(join(dir, "air.yaml"), "utf8"));
    const io = bufferIO();
    expect(() => runApprove(custom, ["whatever"], io)).toThrow(
      "Approval requires the bundle's canonical air.yaml or air.json, not",
    );
  });

  it("refuses an incomplete bundle, listing every missing required file", async () => {
    const dir = await paymentsBundle();
    // REQUIRED_BUNDLE_FILES lists mcp/resources.json before skill/SKILL.md,
    // and the guard reports them in that declared order, not removal order.
    rmSync(join(dir, "skill", "SKILL.md"));
    rmSync(join(dir, "mcp", "resources.json"));
    const io = bufferIO();
    expect(() => runApprove(dir, ["whatever"], io)).toThrow(
      "missing mcp/resources.json, skill/SKILL.md. Run `anvil compile` first.",
    );
  });
});

describe("anvil approve — approval validation guards", () => {
  it("rejects multiple unknown operation ids in one message", async () => {
    const dir = await paymentsBundle();
    const io = bufferIO();
    expect(() => runApprove(dir, ["payments.nope.one", "payments.nope.two"], io)).toThrow(
      "Unknown operation id(s): payments.nope.one, payments.nope.two.",
    );
  });

  it("checks unknown ids before blocked ids (unknown wins first)", async () => {
    const blockedManifest = `
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
  capturePayment:
    side_effect: mutation
    risk: financial
    idempotency:
      strategy: required_request_key
      key_location: header
      header: Content-Type
    confirmation:
      required: true
      risk: financial
`;
    const dir = await compileWithManifest(blockedManifest);
    const air = airFromYaml(readFileSync(join(dir, "air.yaml"), "utf8"));
    const blockedId = opId(air, "capturePayment");
    expect(air.operations.find((o) => o.id === blockedId)?.state).toBe("blocked");

    const io = bufferIO();
    expect(() => runApprove(dir, ["payments.totally.unknown", blockedId], io)).toThrow(
      "Unknown operation id(s): payments.totally.unknown.",
    );
  });

  it("refuses a blocked operation with a dedicated message, leaving the bundle unchanged", async () => {
    const blockedManifest = `
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
  capturePayment:
    side_effect: mutation
    risk: financial
    idempotency:
      strategy: required_request_key
      key_location: header
      header: Content-Type
    confirmation:
      required: true
      risk: financial
`;
    const dir = await compileWithManifest(blockedManifest);
    const air = airFromYaml(readFileSync(join(dir, "air.yaml"), "utf8"));
    const blockedId = opId(air, "capturePayment");
    expect(air.operations.find((o) => o.id === blockedId)?.state).toBe("blocked");

    const before = readBundleDir(dir);
    const io = bufferIO();
    expect(() => runApprove(dir, [blockedId], io)).toThrow(
      `Blocked operation(s) cannot be approved: ${blockedId}. Resolve their blocking diagnostics and recompile first.`,
    );
    expect(readBundleDir(dir)).toEqual(before);
  });
});

describe("anvil approve — duplicate ids and already-approved no-ops", () => {
  it("collapses duplicate requested ids via Set before counting", async () => {
    const approvedManifest = `
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
    state: approved
    idempotency:
      strategy: natural
  capturePayment:
    state: approved
    idempotency:
      strategy: natural
  getCustomer:
    state: approved
  getPayment:
    state: approved
`;
    const dir = await compileWithManifest(approvedManifest);
    const air = airFromYaml(readFileSync(join(dir, "air.yaml"), "utf8"));
    const id = opId(air, "getCustomer");

    const before = readBundleDir(dir);
    const io = bufferIO();
    const code = await runAnvilCli(["approve", dir, id, id, id], { io });
    expect(code, io.text()).toBe(0);
    // 3 raw ids on argv collapse to 1 requested id — never triple-counted.
    expect(io.text()).toContain("Approved 0 new operation(s) (1 requested)");
    expect(io.text()).toContain("1 operation(s) were already approved.");
    // Nothing actually changed, so no "preserved ... stale" chatter either.
    expect(io.text()).not.toContain("Preserved");
    expect(readBundleDir(dir)).toEqual(before);
  });
});

describe("anvil approve — safety invariant: only approved operations are exposed", () => {
  it("exposes a newly-approved mutation with confirmation/idempotency/retries preserved verbatim, and still hides a sibling pending operation", async () => {
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
    retries:
      enabled: true
      only_on:
        - timeout
        - "429"
        - "503"
      max_attempts: 3
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
    state: review_required
`;
    const dir = await compileWithManifest(manifest);
    const before = airFromYaml(readFileSync(join(dir, "air.yaml"), "utf8"));
    const refundId = opId(before, "createRefund");
    const pendingGetPaymentId = opId(before, "getPayment");
    expect(before.operations.find((o) => o.id === refundId)?.state).toBe("review_required");

    const io = bufferIO();
    const code = runApprove(dir, [refundId], io);
    expect(code, io.text()).toBe(0);
    expect(io.text()).toContain("Approved 1 new operation(s) (1 requested)");

    const files = readBundleDir(dir);
    const runtime = JSON.parse(files["runtime/operations.manifest.json"] as string) as {
      operations: Array<{
        id: string;
        confirmation: { required: boolean };
        idempotency: { mode: string; mechanism: string; key?: string };
        retries: { mode: string; maxAttempts: number };
      }>;
    };

    // The pending sibling never reaches the runtime surface: only approved
    // operations are exposed, even after an unrelated approval regenerates
    // every projection.
    expect(runtime.operations.map((op) => op.id)).not.toContain(pendingGetPaymentId);

    const entry = runtime.operations.find((op) => op.id === refundId);
    expect(entry).toBeDefined();
    expect(entry?.confirmation).toEqual({ required: true });
    expect(entry?.idempotency).toMatchObject({
      mode: "required",
      mechanism: "header",
      key: "Idempotency-Key",
    });
    expect(entry?.retries).toMatchObject({ mode: "safe", maxAttempts: 3 });

    const canonical = airFromYaml(files["air.yaml"] as string);
    expect(canonical.operations.find((o) => o.id === refundId)?.state).toBe("approved");
    expect(canonical.operations.find((o) => o.id === pendingGetPaymentId)?.state).toBe(
      "review_required",
    );
  });
});

describe("anvil approve — immutable gateway import lineage guard", () => {
  it("refuses to approve a pending operation on a receipt-bound bundle, leaving it byte-for-byte unchanged", async () => {
    const { bundle } = await importedGatewayBundle();
    const air = loadAir(bundle);
    const target = air.operations.find((op) => op.state !== "approved");
    if (!target)
      throw new Error("expected the freshly imported bundle to have a pending operation");
    const receipt = JSON.parse(readFileSync(join(bundle, "import.receipt.json"), "utf8")) as {
      importId: string;
    };

    const before = readBundleDir(bundle);
    const io = bufferIO();
    let thrown: Error | undefined;
    try {
      runApprove(bundle, [target.id], io);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).toContain(`is bound to immutable gateway receipt ${receipt.importId}`);
    expect(thrown?.message).toContain("anvil estate import");
    expect(thrown?.message).toContain(`Requested operation(s): ${target.id}.`);
    expect(readBundleDir(bundle)).toEqual(before);
  });

  it("refuses with a dedicated message when import.receipt.json is not valid JSON", async () => {
    const { bundle } = await importedGatewayBundle();
    const air = loadAir(bundle);
    const target = air.operations.find((op) => op.state !== "approved");
    if (!target) throw new Error("expected a pending operation");
    writeFileSync(join(bundle, "import.receipt.json"), "{not json");

    const io = bufferIO();
    expect(() => runApprove(bundle, [target.id], io)).toThrow(
      "Operation approval refused: gateway import.receipt.json is not valid JSON.",
    );
  });

  it("refuses with a dedicated message when import.receipt.json fails the receipt-view schema", async () => {
    const { bundle } = await importedGatewayBundle();
    const air = loadAir(bundle);
    const target = air.operations.find((op) => op.state !== "approved");
    if (!target) throw new Error("expected a pending operation");
    writeFileSync(join(bundle, "import.receipt.json"), JSON.stringify({ hello: "world" }));

    const io = bufferIO();
    expect(() => runApprove(bundle, [target.id], io)).toThrow(
      "Operation approval refused: gateway import.receipt.json is not a valid receipt view.",
    );
  });

  it("reprojectBundleAtomically independently refuses in-place output changes on a receipt-bound bundle", async () => {
    // commands/capability.ts calls reprojectBundleAtomically directly, so the
    // guard must hold even when the caller bypasses runApprove's own
    // newlyApproved precheck. Mutate the in-memory AIR by hand (as
    // capability.ts does) rather than going through runApprove.
    const { bundle } = await importedGatewayBundle();
    const air = loadAir(bundle);
    const target = air.operations.find((op) => op.state !== "approved");
    if (!target) throw new Error("expected a pending operation");
    approveOperations(air, [target.id]);
    expect(air.operations.find((op) => op.id === target.id)?.state).toBe("approved");

    const before = readBundleDir(bundle);
    expect(() => reprojectBundleAtomically(bundle, air, "test reprojection reason")).toThrow(
      /^Bundle reprojection refused: .* is bound to immutable gateway receipt/,
    );
    expect(readBundleDir(bundle)).toEqual(before);
  });
});

describe("anvil approve — corrupt canonical AIR", () => {
  it("propagates a parse failure through the CLI as a non-zero exit, never a silent success", async () => {
    const dir = await paymentsBundle();
    writeFileSync(join(dir, "air.yaml"), "service: [this is not a valid AIR document\n");
    const io = bufferIO();
    const code = await runAnvilCli(["approve", dir, "whatever"], { io });
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("anvil:");
  });
});

describe("anvil approve — BUG: misleading success report when approval blocks instead of approves", () => {
  // BUG: approveOperations() (packages/compiler/src/compile.ts) can leave a
  // requested operation in state "blocked" (never "approved") when its
  // idempotency carrier cannot be resolved — but runApprove() computes
  // `newlyApproved` from the *pre-mutation* state and unconditionally reports
  // every one of those ids as approved ("Approved N new operation(s)..."),
  // returning exit code 0. A caller reading the CLI's own success message has
  // no way to learn the operation was actually left blocked (and therefore
  // still unexposed) rather than approved. This is reachable whenever a
  // hand-edited air.yaml carries a non-"blocked" state alongside a broken
  // idempotency carrier — plausible since `anvil approve` explicitly accepts
  // "generated bundle directory or air.yaml" and this repo's own status
  // command treats direct air.yaml edits as a first-class case.
  it.fails("BUG: runApprove reports an operation as approved even when it actually ends up blocked", async () => {
    const dir = await paymentsBundle();
    const air = airFromYaml(readFileSync(join(dir, "air.yaml"), "utf8"));
    const target = air.operations.find((op) => op.state !== "approved" && op.state !== "blocked");
    if (!target) throw new Error("expected a non-approved, non-blocked operation in the fixture");
    // A carrier that can never resolve: "required" mode demands an explicit
    // mechanism, and "none" is not one.
    target.idempotency = { mode: "required", mechanism: "none", keyDerivation: "none" };
    writeFileSync(join(dir, "air.yaml"), airToYaml(air));

    const io = bufferIO();
    const code = runApprove(dir, [target.id], io);

    // Correct behavior: a request that actually leaves the operation
    // blocked must not be reported (or exit) as a plain success.
    expect(code).not.toBe(0);
    const finalState = JSON.parse(readFileSync(join(dir, "air.json"), "utf8")) as {
      operations: Array<{ id: string; state: string }>;
    };
    expect(finalState.operations.find((o) => o.id === target.id)?.state).not.toBe("blocked");
  });
});
