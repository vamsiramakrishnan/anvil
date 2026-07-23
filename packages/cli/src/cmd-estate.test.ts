import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGeminiEnterpriseTargetConfig,
  GEMINI_ENTERPRISE_PROFILE,
  generateTargetKit,
} from "@anvil/targets";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

/**
 * `anvil estate` — the CLI seam onto the gateway adapters. The zip cases go
 * through the REAL archive path (fflate decode + the ADR-0020 safety battery),
 * so this is the end-to-end "a vendor export becomes a bundle" proof.
 */

const KONG_ONE_SERVICE = `_format_version: "3.0"
services:
  - name: refunds
    url: https://backend.internal/refunds
    routes:
      - name: refunds-route
        paths: ["/refunds"]
        methods: ["GET", "POST"]
    plugins:
      - name: openid-connect
        config:
          scopes: ["refunds:write"]
      - name: rate-limiting
        config:
          minute: 100
      - name: some-custom-plugin
        config:
          foo: bar
`;

const KONG_TWO_SERVICES = `${KONG_ONE_SERVICE}  - name: reporting
    url: https://backend.internal/reports
    routes:
      - name: reports-route
        paths: ["/reports"]
        methods: ["GET"]
`;

const KONG_AUTH_ONLY = `_format_version: "3.0"
services:
  - name: refunds
    url: https://backend.internal/refunds
    routes:
      - name: refunds-route
        paths: ["/refunds/{id}"]
        methods: ["GET"]
    plugins:
      - name: openid-connect
        config:
          scopes: ["refunds:read"]
`;

const KONG_NO_ROUTES = `_format_version: "3.0"
services:
  - name: empty-api
    url: https://backend.internal/empty
    routes: []
`;

const REFUNDS_OPENAPI = `openapi: "3.0.3"
info: { title: Refunds, version: "1.0.0" }
servers:
  - url: https://gateway.example.test
components:
  securitySchemes:
    enterprise_oidc:
      type: oauth2
      flows:
        clientCredentials:
          tokenUrl: https://idp.example.test/oauth/token
          scopes:
            refunds:read: Read refunds
security:
  - enterprise_oidc: [refunds:read]
paths:
  /refunds/{id}:
    get:
      operationId: fetchRefund
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
`;

const INCOMPLETE_REFUNDS_OPENAPI = `openapi: "3.0.3"
info: { title: Refunds, version: "1.0.0" }
paths:
  /refunds/{id}:
    get:
      operationId: fetchRefund
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
`;

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

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-estate-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

async function estate(...argv: string[]) {
  const io = bufferIO();
  const scoped =
    (argv[0] === "import" || argv[0] === "verify") && !argv.includes("--root")
      ? [...argv, "--root", work]
      : argv;
  const code = await runAnvilCli(["estate", ...scoped], { io });
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

describe("anvil estate inventory", () => {
  it("lists the APIs in a bare Kong declarative config", async () => {
    const cfg = join(work, "kong.yaml");
    writeFileSync(cfg, KONG_TWO_SERVICES);
    const { code, out } = await estate("inventory", cfg, "--vendor", "kong");
    expect(code).toBe(0);
    expect(out).toContain("2 API(s)");
    expect(out).toContain("refunds");
    expect(out).toContain("reporting");
  });

  it("refuses an unknown vendor by naming the valid set", async () => {
    const cfg = join(work, "kong.yaml");
    writeFileSync(cfg, KONG_ONE_SERVICE);
    const { code, err } = await estate("inventory", cfg, "--vendor", "nginx");
    expect(code).toBe(1);
    expect(err).toMatch(/kong.*apigee|apigee.*kong/i);
  });

  it("reports route synthesis as degraded contract provenance, never hasSpec", async () => {
    const cfg = join(work, "kong.yaml");
    writeFileSync(cfg, KONG_ONE_SERVICE);
    const { code, out } = await estate("inventory", cfg, "--vendor", "kong", "--json");
    expect(code).toBe(0);
    const inventory = JSON.parse(out);
    expect(inventory.apis[0]).toMatchObject({
      hasSpec: false,
      contract: {
        kind: "synthesized",
        fidelity: "route_only",
        location: {
          origin: expect.stringMatching(/^gateway-export:\/\/sha256:[0-9a-f]{64}$/),
          pointer: "/services/0",
        },
      },
    });
  });

  it.each([
    "kong",
    "apigee",
    "wso2",
    "mulesoft",
    "api_connect",
  ])("rejects an OpenAPI document passed as a %s vendor export", async (vendor) => {
    const cfg = join(work, `${vendor}.yaml`);
    writeFileSync(cfg, REFUNDS_OPENAPI);
    const { code, out } = await estate("inventory", cfg, "--vendor", vendor, "--json");
    expect(code).toBe(1);
    const inventory = JSON.parse(out);
    expect(inventory.apis).toEqual([]);
    expect(inventory.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "error", code: expect.stringMatching(/invalid_export/) }),
      ]),
    );
  });

  it.each([
    "kong",
    "apigee",
    "wso2",
    "mulesoft",
    "api_connect",
  ])("rejects an empty %s vendor export with a structured diagnostic", async (vendor) => {
    const cfg = join(work, `${vendor}-empty.yaml`);
    writeFileSync(cfg, "");
    const { code, out } = await estate("inventory", cfg, "--vendor", vendor, "--json");
    expect(code).toBe(1);
    const inventory = JSON.parse(out);
    expect(inventory.apis).toEqual([]);
    expect(inventory.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "error", code: expect.stringMatching(/empty|invalid/) }),
      ]),
    );
  });
});

describe("anvil estate import", () => {
  it("imports the single API of a bare config into a normal bundle", async () => {
    const cfg = join(work, "kong.yaml");
    writeFileSync(cfg, KONG_ONE_SERVICE);
    const out = join(work, "bundle");
    const res = await estate("import", cfg, "--vendor", "kong", "--out", out);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Imported refunds");
    // The bundle is a NORMAL bundle: catalog + skill + hooks all present.
    expect(existsSync(join(out, "catalog.json"))).toBe(true);
    expect(existsSync(join(out, "skill/SKILL.md"))).toBe(true);
    expect(existsSync(join(out, "plugin/hookcore.mjs"))).toBe(true);
    const catalog = JSON.parse(readFileSync(join(out, "catalog.json"), "utf8"));
    expect(catalog.operations.length).toBeGreaterThan(0);
    const air = parseYaml(readFileSync(join(out, "air.yaml"), "utf8"));
    expect(
      air.operations.every((operation: { state: string }) => operation.state === "blocked"),
    ).toBe(true);
    expect(air.diagnostics.map((d: { code: string }) => d.code)).toEqual(
      expect.arrayContaining([
        "gateway/route_only_contract",
        "gateway/missing_runtime_coordinate",
        "gateway/auth_contract_incomplete",
        "gateway/opaque_policy",
      ]),
    );
    // The unknown plugin must surface as an opaque policy, never vanish.
    expect(res.out).toMatch(/opaque/i);
    expect(res.out).toContain("--spec");
  });

  it("locks a supplied full contract, retargets gateway policy, and clears route-only guards", async () => {
    const cfg = join(work, "kong.yaml");
    const spec = join(work, "refunds.openapi.yaml");
    const out = join(work, "bundle-full");
    writeFileSync(cfg, KONG_AUTH_ONLY);
    writeFileSync(spec, REFUNDS_OPENAPI);

    const res = await estate(
      "import",
      cfg,
      "--vendor",
      "kong",
      "--spec",
      spec,
      "--gateway-url",
      "https://edge.gateway.example.test/public/",
      "--root",
      work,
      "--out",
      out,
      "--json",
    );
    expect(res.code).toBe(0);
    const report = JSON.parse(res.out);
    expect(report.contract).toMatchObject({
      kind: "native",
      fidelity: "full",
      format: "openapi",
      source: {
        snapshotId: report.source.snapshotId,
        sourceHash: report.source.sourceHash,
      },
    });
    expect(report.contract.location.origin).toBe(
      `$WORKSPACE/.anvil/sources/${report.source.snapshotId}/raw`,
    );
    expect(report.source.lock.directory).toContain(".anvil/sources");
    expect(report.operations.blocked).toBe(0);
    expect(report.diagnostics.map((d: { code: string }) => d.code)).not.toEqual(
      expect.arrayContaining([
        "gateway/route_only_contract",
        "gateway/missing_runtime_coordinate",
        "gateway/auth_contract_incomplete",
      ]),
    );

    const air = parseYaml(readFileSync(join(out, "air.yaml"), "utf8"));
    const operation = air.operations.find(
      (candidate: { sourceRef?: { operationId?: string } }) =>
        candidate.sourceRef?.operationId === "fetchRefund",
    );
    expect(operation).toBeDefined();
    expect(operation.state).not.toBe("blocked");
    expect(operation.auth.type).not.toBe("none");
    expect(operation.auth.scopes).toContain("refunds:read");
    expect(operation.input.params).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "id", in: "path", required: true })]),
    );
    expect(air.service.source).toMatchObject({
      snapshotId: report.source.snapshotId,
      sourceHash: report.source.sourceHash,
      entrypoint: "refunds.openapi.yaml",
    });
    expect(air.service.servers).toEqual([
      {
        url: "https://edge.gateway.example.test/public",
        description: "Operator-attested public API gateway endpoint",
      },
    ]);

    const receipt = JSON.parse(
      readFileSync(join(report.receipt.directory, "import.receipt.json"), "utf8"),
    );
    expect(air.service.source).toMatchObject(receipt.contract.compilerSource);
    expect(receipt.lockedSource).toMatchObject({
      snapshotId: report.source.snapshotId,
      sourceHash: report.source.sourceHash,
    });
    expect(receipt.runtime).toEqual({
      gatewayUrl: "https://edge.gateway.example.test/public",
      attestation: "operator",
    });
    expect(
      receipt.lockedSource.files.find(
        (file: { path: string }) => file.path === "refunds.openapi.yaml",
      ),
    ).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });

    const verified = await estate(
      "verify",
      report.receipt.importId,
      "--root",
      work,
      "--bundle",
      out,
      "--json",
    );
    expect(verified.code).toBe(0);
    expect(JSON.parse(verified.out)).toMatchObject({
      ok: true,
      receipt: { ok: true },
      source: { checked: true, ok: true, snapshotId: report.source.snapshotId },
      output: { checked: true, ok: true, bundle: out },
    });
  });

  it("requires an explicit HTTPS gateway coordinate before accepting a full contract", async () => {
    const cfg = join(work, "kong.yaml");
    const spec = join(work, "refunds.openapi.yaml");
    const out = join(work, "bundle-no-gateway");
    writeFileSync(cfg, KONG_AUTH_ONLY);
    writeFileSync(spec, REFUNDS_OPENAPI);

    const missing = await estate("import", cfg, "--vendor", "kong", "--spec", spec, "--out", out);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("--gateway-url");
    expect(existsSync(out)).toBe(false);

    const insecure = await estate(
      "import",
      cfg,
      "--vendor",
      "kong",
      "--spec",
      spec,
      "--gateway-url",
      "http://gateway.example.test",
      "--out",
      out,
    );
    expect(insecure.code).toBe(1);
    expect(insecure.err).toMatch(/must use HTTPS/i);
    expect(existsSync(out)).toBe(false);
  });

  it("blocks unmodelled route and global Kong policy placement with a full contract", async () => {
    const cfg = join(work, "kong-effective-policy.yaml");
    const spec = join(work, "refunds.openapi.yaml");
    const out = join(work, "bundle-effective-policy");
    writeFileSync(
      cfg,
      `_format_version: "3.0"
plugins:
  - name: ip-restriction
services:
  - name: refunds
    routes:
      - name: refunds-route
        paths: ["/refunds/{id}"]
        methods: ["GET"]
        plugins:
          - name: request-termination
`,
    );
    writeFileSync(spec, REFUNDS_OPENAPI);

    const result = await estate(
      "import",
      cfg,
      "--vendor",
      "kong",
      "--spec",
      spec,
      "--gateway-url",
      "https://gateway.example.test",
      "--out",
      out,
      "--json",
    );
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.operations.blocked).toBe(1);
    expect(
      report.diagnostics.filter((d: { code: string }) => d.code === "gateway/opaque_policy"),
    ).toHaveLength(2);
  });

  it("blocks a completely unrelated supplied spec even when the gateway has no policy assertions", async () => {
    const cfg = join(work, "kong-no-policy.yaml");
    const spec = join(work, "unrelated.openapi.yaml");
    const out = join(work, "bundle-unrelated");
    writeFileSync(
      cfg,
      `_format_version: "3.0"
services:
  - name: refunds
    routes:
      - name: refunds-route
        paths: ["/refunds/{refund_id}"]
        methods: ["GET"]
`,
    );
    writeFileSync(
      spec,
      `openapi: "3.0.3"
info: { title: Unrelated, version: "1.0.0" }
paths:
  /employees/{employee_id}:
    get:
      operationId: fetchEmployee
      parameters:
        - { name: employee_id, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
`,
    );

    const result = await estate(
      "import",
      cfg,
      "--vendor",
      "kong",
      "--spec",
      spec,
      "--gateway-url",
      "https://gateway.example.test",
      "--out",
      out,
      "--json",
    );
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.operations).toMatchObject({ total: 1, blocked: 1 });
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "gateway/route_set_missing" }),
        expect.objectContaining({ code: "gateway/route_set_extra" }),
      ]),
    );
  });

  it("refuses duplicate gateway API ids instead of silently importing the first", async () => {
    const cfg = join(work, "kong-duplicate.yaml");
    const out = join(work, "bundle-duplicate");
    writeFileSync(
      cfg,
      `_format_version: "3.0"
services:
  - name: duplicate
    routes: [{ paths: ["/one"], methods: ["GET"] }]
  - name: duplicate
    routes: [{ paths: ["/two"], methods: ["GET"] }]
`,
    );

    const inventory = await estate("inventory", cfg, "--vendor", "kong", "--json");
    expect(inventory.code).toBe(1);
    expect(JSON.parse(inventory.out).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "error", code: "gateway/duplicate_api_id" }),
      ]),
    );

    const imported = await estate(
      "import",
      cfg,
      "--vendor",
      "kong",
      "--api",
      "duplicate",
      "--out",
      out,
    );
    expect(imported.code).toBe(1);
    expect(imported.err).toContain("ambiguous or invalid");
    expect(existsSync(out)).toBe(false);
  });

  it("does not retarget gateway policy by a colliding operationId on the wrong route", async () => {
    const cfg = join(work, "kong.yaml");
    const routeOnlyOut = join(work, "bundle-route-only");
    writeFileSync(cfg, KONG_AUTH_ONLY);
    const routeOnly = await estate(
      "import",
      cfg,
      "--vendor",
      "kong",
      "--out",
      routeOnlyOut,
      "--json",
    );
    expect(routeOnly.code).toBe(0);
    const synthesizedAir = parseYaml(readFileSync(join(routeOnlyOut, "air.yaml"), "utf8"));
    const collidingOperationId = synthesizedAir.operations[0].sourceRef.operationId;

    const wrongSpec = join(work, "wrong-route.openapi.yaml");
    writeFileSync(
      wrongSpec,
      `openapi: "3.0.3"
info: { title: Wrong route, version: "1.0.0" }
servers: [{ url: https://gateway.example.test }]
components:
  securitySchemes:
    enterprise_oidc:
      type: oauth2
      flows:
        clientCredentials:
          tokenUrl: https://idp.example.test/oauth/token
          scopes: { refunds:read: Read refunds }
security: [{ enterprise_oidc: [refunds:read] }]
paths:
  /different/{id}:
    get:
      operationId: ${collidingOperationId}
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
`,
    );
    const out = join(work, "bundle-wrong-route");
    const result = await estate(
      "import",
      cfg,
      "--vendor",
      "kong",
      "--spec",
      wrongSpec,
      "--gateway-url",
      "https://gateway.example.test",
      "--root",
      work,
      "--out",
      out,
      "--json",
    );
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "gateway/policy_target_unmatched" }),
      ]),
    );
    expect(report.operations.blocked).toBe(1);
    const air = parseYaml(readFileSync(join(out, "air.yaml"), "utf8"));
    expect(air.operations[0]).toMatchObject({
      state: "blocked",
      sourceRef: { path: "/different/{id}" },
    });
  });

  it("keeps a supplied contract blocked when IdP/security details are still missing", async () => {
    const cfg = join(work, "kong.yaml");
    const spec = join(work, "refunds-incomplete.openapi.yaml");
    const out = join(work, "bundle-incomplete");
    writeFileSync(cfg, KONG_AUTH_ONLY);
    writeFileSync(spec, INCOMPLETE_REFUNDS_OPENAPI);

    const res = await estate(
      "import",
      cfg,
      "--vendor",
      "kong",
      "--spec",
      spec,
      "--gateway-url",
      "https://gateway.example.test",
      "--root",
      work,
      "--out",
      out,
      "--json",
    );
    expect(res.code).toBe(0);
    const report = JSON.parse(res.out);
    expect(report.operations.blocked).toBe(1);
    expect(report.diagnostics.map((d: { code: string }) => d.code)).toEqual(
      expect.arrayContaining(["gateway/auth_contract_incomplete"]),
    );
    expect(report.diagnostics.map((d: { code: string }) => d.code)).not.toContain(
      "gateway/missing_runtime_coordinate",
    );

    const air = parseYaml(readFileSync(join(out, "air.yaml"), "utf8"));
    expect(air.operations[0].state).toBe("blocked");
    expect(air.diagnostics.map((d: { code: string }) => d.code)).toEqual(
      expect.arrayContaining(["gateway/auth_contract_incomplete"]),
    );
  });

  it("stops before bundle or receipt creation when the selected API has no operations", async () => {
    const cfg = join(work, "kong-empty.yaml");
    const out = join(work, "bundle-empty");
    writeFileSync(cfg, KONG_NO_ROUTES);

    const result = await estate("import", cfg, "--vendor", "kong", "--out", out, "--json");
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({
      operations: { total: 0 },
      output: { created: false },
      receipt: { created: false },
    });
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "error", code: "gateway/no_operations" }),
      ]),
    );
    expect(existsSync(out)).toBe(false);
    expect(existsSync(join(work, ".anvil", "imports"))).toBe(false);
  });

  it("stores a secret-free deterministic receipt, does not rewrite it, and detects raw tampering", async () => {
    const secret = "client-secret-MUST-NOT-ENTER-RECEIPT";
    const config = KONG_AUTH_ONLY.replace(
      'scopes: ["refunds:read"]',
      `scopes: ["refunds:read"]\n          client_secret: ${secret}`,
    );
    const cfg = join(work, "kong-secret.yaml");
    const out = join(work, "bundle-receipt");
    writeFileSync(cfg, config);
    const args = ["import", cfg, "--vendor", "kong", "--out", out, "--json"];

    const first = await estate(...args);
    expect(first.code).toBe(0);
    const firstReport = JSON.parse(first.out);
    expect(firstReport.receipt).toMatchObject({
      importId: expect.stringMatching(/^gwi-[0-9a-f]{16}$/),
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      created: true,
      integrity: { ok: true },
    });
    const receiptPath = join(firstReport.receipt.directory, "import.receipt.json");
    const rawPath = join(firstReport.receipt.directory, "raw", "export.bin");
    const receiptStat = statSync(receiptPath);
    const rawStat = statSync(rawPath);
    expect(readFileSync(rawPath, "utf8")).toBe(config);
    expect(readFileSync(receiptPath, "utf8")).not.toContain(secret);

    const viewText = readFileSync(join(out, "import.receipt.json"), "utf8");
    const view = JSON.parse(viewText);
    expect(view).toMatchObject({
      viewType: "anvil.gateway-import-receipt-view",
      redacted: true,
      importId: firstReport.receipt.importId,
      receiptDigest: firstReport.receipt.digest,
      privateReceipt: {
        workspaceRoot: "$WORKSPACE",
        verifyCommand: `anvil estate verify ${firstReport.receipt.importId} --root .`,
      },
    });
    expect(view).not.toHaveProperty("receiptType");
    expect(view).not.toHaveProperty("digest");
    expect(viewText).not.toContain(secret);
    expect(viewText).not.toContain(cfg);

    const second = await estate(...args);
    expect(second.code).toBe(0);
    const secondReport = JSON.parse(second.out);
    expect(secondReport.receipt).toMatchObject({
      importId: firstReport.receipt.importId,
      digest: firstReport.receipt.digest,
      created: false,
    });
    expect(statSync(receiptPath).ino).toBe(receiptStat.ino);
    expect(statSync(receiptPath).mtimeMs).toBe(receiptStat.mtimeMs);
    expect(statSync(rawPath).ino).toBe(rawStat.ino);
    expect(statSync(rawPath).mtimeMs).toBe(rawStat.mtimeMs);

    const cleanupIo = bufferIO();
    const cleanupCode = await runAnvilCli(["estate", ...args, "--root", work], {
      io: cleanupIo,
      cleanupGatewayBundleBackup: () => {
        throw new Error("injected backup cleanup failure");
      },
    });
    expect(cleanupCode, cleanupIo.text()).toBe(0);
    const cleanupReport = JSON.parse(cleanupIo.stdout.join("\n"));
    expect(cleanupReport.output).toMatchObject({
      ok: true,
      installed: true,
      retainedBackup: expect.stringContaining(".bundle-receipt.anvil-previous-"),
      cleanupWarning: expect.stringContaining("injected backup cleanup failure"),
    });
    expect(existsSync(cleanupReport.output.retainedBackup)).toBe(true);

    const elsewhere = join(work, "elsewhere");
    mkdirSync(elsewhere);
    const priorCwd = process.cwd();
    let intact: Awaited<ReturnType<typeof estate>>;
    try {
      process.chdir(elsewhere);
      intact = await estate(
        "verify",
        firstReport.receipt.importId,
        "--root",
        work,
        "--bundle",
        out,
        "--json",
      );
    } finally {
      process.chdir(priorCwd);
    }
    expect(intact.code).toBe(0);
    expect(JSON.parse(intact.out)).toMatchObject({
      ok: true,
      receipt: { ok: true },
      output: { checked: true, ok: true },
    });

    const alteredView = JSON.parse(viewText);
    alteredView.privateReceipt.verifyCommand = "anvil estate verify the-wrong-import";
    writeFileSync(join(out, "import.receipt.json"), `${JSON.stringify(alteredView, null, 2)}\n`);
    const altered = await estate("verify", firstReport.receipt.importId, "--bundle", out, "--json");
    expect(altered.code).toBe(1);
    expect(JSON.parse(altered.out).output.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "gateway_receipt/bundle_receipt_mismatch" }),
      ]),
    );
    writeFileSync(join(out, "import.receipt.json"), viewText);

    writeFileSync(join(out, "unexpected.txt"), "not in the receipt");
    const added = await estate("verify", firstReport.receipt.importId, "--bundle", out, "--json");
    expect(added.code).toBe(1);
    expect(JSON.parse(added.out).output.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "gateway_receipt/output_added",
          path: "unexpected.txt",
        }),
      ]),
    );
    rmSync(join(out, "unexpected.txt"));

    const unknownTarget = join(out, "targets", "unknown-platform", "operator-note.txt");
    mkdirSync(join(unknownTarget, ".."), { recursive: true });
    writeFileSync(unknownTarget, "must not be silently trusted or deleted\n");
    const unverifiedTarget = await estate(
      "verify",
      firstReport.receipt.importId,
      "--bundle",
      out,
      "--json",
    );
    expect(unverifiedTarget.code).toBe(1);
    expect(JSON.parse(unverifiedTarget.out).output.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "gateway_receipt/unverified_target",
          path: "targets/unknown-platform",
        }),
      ]),
    );
    const refusedUnknownTargetReplacement = await estate(...args);
    expect(refusedUnknownTargetReplacement.code).toBe(1);
    expect(JSON.parse(refusedUnknownTargetReplacement.out).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "gateway_receipt/unverified_target",
          path: "targets/unknown-platform",
        }),
      ]),
    );
    expect(readFileSync(unknownTarget, "utf8")).toContain("must not be silently");
    rmSync(join(out, "targets"), { recursive: true });

    writeFileSync(rawPath, "tampered");
    const tampered = await estate("verify", firstReport.receipt.importId, "--json");
    expect(tampered.code).toBe(1);
    const tamperedReport = JSON.parse(tampered.out);
    expect(tamperedReport.ok).toBe(false);
    expect(tamperedReport.receipt.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "gateway_receipt/export_changed" })]),
    );
  });

  it("derives identical receipt and bundle bytes from identical inputs in different roots", async () => {
    const roots = [join(work, "root-a"), join(work, "root-b")];
    type CrossRootReport = {
      receipt: { importId: string; digest: string; directory: string };
    };
    const results: Array<{
      report: CrossRootReport;
      air: Buffer;
      view: Buffer;
      receipt: Buffer;
    }> = [];
    for (const root of roots) {
      mkdirSync(root, { recursive: true });
      const cfg = join(root, "kong.yaml");
      const spec = join(root, "refunds.openapi.yaml");
      const out = join(root, "bundle");
      writeFileSync(cfg, KONG_AUTH_ONLY);
      writeFileSync(spec, REFUNDS_OPENAPI);
      const imported = await estate(
        "import",
        cfg,
        "--vendor",
        "kong",
        "--spec",
        spec,
        "--gateway-url",
        "https://gateway.example.test",
        "--root",
        root,
        "--out",
        out,
        "--json",
      );
      expect(imported.code).toBe(0);
      const report = JSON.parse(imported.out) as CrossRootReport;
      results.push({
        report,
        air: readFileSync(join(out, "air.yaml")),
        view: readFileSync(join(out, "import.receipt.json")),
        receipt: readFileSync(join(report.receipt.directory, "import.receipt.json")),
      });
    }

    expect(results[1]?.report.receipt.importId).toBe(results[0]?.report.receipt.importId);
    expect(results[1]?.report.receipt.digest).toBe(results[0]?.report.receipt.digest);
    expect(results[1]?.air).toEqual(results[0]?.air);
    expect(results[1]?.view).toEqual(results[0]?.view);
    expect(results[1]?.receipt).toEqual(results[0]?.receipt);
    expect(results[0]?.view.toString("utf8")).not.toContain(roots[0] as string);
    expect(results[1]?.view.toString("utf8")).not.toContain(roots[1] as string);
  });

  it("preserves certification and report lifecycle artifacts during verify and bound re-import", async () => {
    const cfg = join(work, "kong-lifecycle.yaml");
    const spec = join(work, "refunds-lifecycle.openapi.yaml");
    const out = join(work, "bundle-lifecycle");
    writeFileSync(cfg, KONG_AUTH_ONLY);
    writeFileSync(spec, REFUNDS_OPENAPI);
    const importArgs = [
      "import",
      cfg,
      "--vendor",
      "kong",
      "--spec",
      spec,
      "--gateway-url",
      "https://gateway.example.test",
      "--root",
      work,
      "--out",
      out,
      "--json",
    ];
    const imported = await estate(...importArgs);
    expect(imported.code).toBe(0);
    const report = JSON.parse(imported.out);

    const statusIo = bufferIO();
    expect(
      await runAnvilCli(["status", out, "--root", work, "--json"], { io: statusIo }),
      statusIo.text(),
    ).toBe(0);
    expect(JSON.parse(statusIo.stdout.join("\n")).source.integrity.state).toBe("fresh");

    const certifyIo = bufferIO();
    expect(await runAnvilCli(["certify", out, "--json"], { io: certifyIo }), certifyIo.text()).toBe(
      0,
    );
    expect(existsSync(join(out, "certification.json"))).toBe(true);
    const certification = readFileSync(join(out, "certification.json"));
    writeFileSync(join(out, "review.report.json"), '{"findings":[]}\n');
    const reviewReport = readFileSync(join(out, "review.report.json"));
    const afterCertify = await estate(
      "verify",
      report.receipt.importId,
      "--root",
      work,
      "--bundle",
      out,
      "--json",
    );
    expect(afterCertify.code, afterCertify.out).toBe(0);

    const reimported = await estate(...importArgs);
    expect(reimported.code, `${reimported.err}\n${reimported.out}`).toBe(0);
    expect(readFileSync(join(out, "certification.json"))).toEqual(certification);
    expect(readFileSync(join(out, "review.report.json"))).toEqual(reviewReport);
    const afterReimport = await estate(
      "verify",
      report.receipt.importId,
      "--root",
      work,
      "--bundle",
      out,
      "--json",
    );
    expect(afterReimport.code, afterReimport.out).toBe(0);
  });

  it("marks approval lineage stale, exposes it to verify/status/certify, and rebases only explicitly", async () => {
    const cfg = join(work, "kong-post.yaml");
    const spec = join(work, "refunds-post.openapi.yaml");
    const out = join(work, "bundle-post");
    writeFileSync(
      cfg,
      `_format_version: "3.0"
services:
  - name: refunds
    routes:
      - name: refunds-post
        paths: ["/refunds"]
        methods: ["POST"]
    plugins:
      - name: openid-connect
        config:
          scopes: ["refunds:write"]
`,
    );
    writeFileSync(spec, REFUNDS_POST_OPENAPI);
    const importArgs = [
      "import",
      cfg,
      "--vendor",
      "kong",
      "--spec",
      spec,
      "--gateway-url",
      "https://gateway.example.test",
      "--root",
      work,
      "--out",
      out,
      "--json",
    ];
    const imported = await estate(...importArgs);
    expect(imported.code).toBe(0);
    const report = JSON.parse(imported.out);
    const air = parseYaml(readFileSync(join(out, "air.yaml"), "utf8"));
    const operation = air.operations.find(
      (candidate: { sourceRef?: { operationId?: string } }) =>
        candidate.sourceRef?.operationId === "createRefund",
    );
    expect(operation).toMatchObject({ state: "review_required" });

    const approvedPreview = structuredClone(air);
    const previewOperation = approvedPreview.operations.find(
      (candidate: { id: string }) => candidate.id === operation.id,
    );
    if (!previewOperation) throw new Error("fixture operation missing from AIR preview");
    previewOperation.state = "approved";
    const targetConfig = createGeminiEnterpriseTargetConfig({
      surface: "custom-mcp",
      serverAuth: "oauth",
      endpoint: "https://mcp.example.test/mcp",
      project: "acme-proj",
      appLocation: "global",
      engine: "eng-1",
      connectorOAuth: {
        provider: "entra",
        tenant: "tenant-123",
        scopes: ["api://anvil-mcp/mcp.invoke"],
        inboundIssuer: "https://login.microsoftonline.com/tenant-123/v2.0",
        inboundAudience: "api://anvil-mcp",
      },
      workforcePool: "locations/global/workforcePools/ge-users",
    });
    const previewTarget = generateTargetKit(
      approvedPreview,
      GEMINI_ENTERPRISE_PROFILE,
      targetConfig,
    );
    for (const file of previewTarget.files) {
      const path = join(out, file.path);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, file.bytes);
    }
    writeFileSync(join(out, "publication.json"), '{"existing":"record"}\n');

    const approveIo = bufferIO();
    expect(
      await runAnvilCli(["approve", out, operation.id], { io: approveIo }),
      approveIo.stderr.join("\n"),
    ).toBe(0);
    const staleView = JSON.parse(readFileSync(join(out, "import.receipt.json"), "utf8"));
    expect(staleView.lineage).toMatchObject({
      status: "stale",
      currentOutputDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      currentOutputFiles: expect.arrayContaining([
        expect.objectContaining({ path: "targets/gemini-enterprise/setup.json" }),
        expect.objectContaining({ path: "publication.json" }),
      ]),
    });
    expect(existsSync(join(out, "targets/gemini-enterprise/setup.json"))).toBe(true);
    expect(readFileSync(join(out, "publication.json"), "utf8")).toBe('{"existing":"record"}\n');

    const targetIo = bufferIO();
    expect(
      await runAnvilCli(
        [
          "target",
          "gemini-enterprise",
          out,
          "--surface",
          "custom-mcp",
          "--server-auth",
          "oauth",
          "--endpoint",
          "https://mcp.example.test/mcp",
          "--project",
          "acme-proj",
          "--location",
          "global",
          "--engine",
          "eng-1",
          "--idp",
          "entra",
          "--tenant",
          "tenant-123",
          "--oauth-scope",
          "api://anvil-mcp/mcp.invoke",
          "--inbound-issuer",
          "https://login.microsoftonline.com/tenant-123/v2.0",
          "--inbound-audience",
          "api://anvil-mcp",
          "--wif",
          "locations/global/workforcePools/ge-users",
        ],
        { io: targetIo },
      ),
      targetIo.text(),
    ).toBe(0);

    const verified = await estate(
      "verify",
      report.receipt.importId,
      "--root",
      work,
      "--bundle",
      out,
      "--json",
    );
    expect(verified.code).toBe(1);
    expect(JSON.parse(verified.out).output.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "gateway_receipt/output_lineage_stale" }),
      ]),
    );
    expect(JSON.parse(verified.out).output.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "gateway_receipt/output_added",
          path: expect.stringMatching(/^targets\//),
        }),
      ]),
    );

    const statusIo = bufferIO();
    expect(await runAnvilCli(["status", out, "--json"], { io: statusIo })).toBe(1);
    expect(JSON.parse(statusIo.stdout.join("\n")).core.contractChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "contract.gateway-lineage-current",
          state: "failed",
        }),
      ]),
    );

    const certifyIo = bufferIO();
    expect(await runAnvilCli(["certify", out, "--json"], { io: certifyIo })).toBe(1);
    expect(JSON.parse(certifyIo.stdout.join("\n")).checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "contract.gateway-lineage-current",
          status: "failed",
        }),
      ]),
    );

    const forgedBoundView = { ...staleView, lineage: { status: "bound" } };
    writeFileSync(
      join(out, "import.receipt.json"),
      `${JSON.stringify(forgedBoundView, null, 2)}\n`,
    );
    const forgedCertifyIo = bufferIO();
    expect(await runAnvilCli(["certify", out, "--json"], { io: forgedCertifyIo })).toBe(1);
    const forgedLineageCheck = JSON.parse(forgedCertifyIo.stdout.join("\n")).checks.find(
      (check: { id: string }) => check.id === "contract.gateway-lineage-current",
    );
    expect(forgedLineageCheck).toMatchObject({ status: "failed" });
    expect(forgedLineageCheck.detail).toMatch(/no longer matches|does not match/i);
    writeFileSync(join(out, "import.receipt.json"), `${JSON.stringify(staleView, null, 2)}\n`);

    const refused = await estate(...importArgs);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.out).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "gateway_receipt/stale_output_requires_replace" }),
      ]),
    );

    const rebased = await estate(...importArgs, "--replace-derived");
    expect(rebased.code, `${rebased.err}\n${rebased.out}`).toBe(0);
    expect(JSON.parse(readFileSync(join(out, "import.receipt.json"), "utf8")).lineage).toEqual({
      status: "bound",
    });
    expect(existsSync(join(out, "targets/gemini-enterprise/setup.json"))).toBe(false);
    expect(existsSync(join(out, "publication.json"))).toBe(false);
    const finalVerify = await estate(
      "verify",
      report.receipt.importId,
      "--root",
      work,
      "--bundle",
      out,
      "--json",
    );
    expect(finalVerify.code).toBe(0);
  });

  it("imports the same config from inside a real ZIP archive", async () => {
    const zipPath = join(work, "export.zip");
    const zipBytes = zipSync({ "kong/kong.yaml": strToU8(KONG_ONE_SERVICE) });
    writeFileSync(zipPath, zipBytes);
    const out = join(work, "bundle-zip");
    const res = await estate("import", zipPath, "--vendor", "kong", "--out", out, "--json");
    expect(res.code).toBe(0);
    expect(existsSync(join(out, "catalog.json"))).toBe(true);
    const report = JSON.parse(res.out);
    const receipt = JSON.parse(
      readFileSync(join(report.receipt.directory, "import.receipt.json"), "utf8"),
    );
    expect(receipt.selection).toMatchObject({
      vendor: "kong",
      apiId: "refunds",
      export: { format: "zip", bytes: zipBytes.byteLength },
      archiveEntry: "kong/kong.yaml",
    });
    expect(readFileSync(join(report.receipt.directory, "raw", "export.bin"))).toEqual(
      Buffer.from(zipBytes),
    );
  });

  it("demands --api when the estate has several, listing them", async () => {
    const cfg = join(work, "kong.yaml");
    writeFileSync(cfg, KONG_TWO_SERVICES);
    const res = await estate("import", cfg, "--vendor", "kong");
    expect(res.code).toBe(1);
    expect(res.err).toContain("--api");
    expect(res.err).toContain("refunds");
    expect(res.err).toContain("reporting");

    const out = join(work, "bundle-picked");
    const picked = await estate(
      "import",
      cfg,
      "--vendor",
      "kong",
      "--api",
      "reporting",
      "--out",
      out,
    );
    expect(picked.code).toBe(0);
    expect(existsSync(join(out, "catalog.json"))).toBe(true);
  });

  it("rejects a hostile archive through the safety battery, reported not silent", async () => {
    const zipPath = join(work, "hostile.zip");
    writeFileSync(
      zipPath,
      zipSync({
        "kong.yaml": strToU8(KONG_ONE_SERVICE),
        "../escape.txt": strToU8("zip-slip"),
      }),
    );
    const res = await estate("import", zipPath, "--vendor", "kong");
    expect(res.code).toBe(1);
    expect(res.err).toContain("archive/unsafe_path");
    expect(res.err).toMatch(/nothing was imported/i);
  });

  it("demands --entry when an archive holds several config-like files", async () => {
    const zipPath = join(work, "multi.zip");
    writeFileSync(
      zipPath,
      zipSync({
        "a/kong.yaml": strToU8(KONG_ONE_SERVICE),
        "b/other.yaml": strToU8("_format_version: '3.0'\nservices: []\n"),
      }),
    );
    const res = await estate("import", zipPath, "--vendor", "kong");
    expect(res.code).toBe(1);
    expect(res.err).toContain("--entry");

    const out = join(work, "bundle-entry");
    const picked = await estate(
      "import",
      zipPath,
      "--vendor",
      "kong",
      "--entry",
      "a/kong.yaml",
      "--out",
      out,
    );
    expect(picked.code).toBe(0);
    expect(existsSync(join(out, "catalog.json"))).toBe(true);
  });

  it("persists the receipt before attempting a bundle installation", async () => {
    const cfg = join(work, "kong.yaml");
    const impossibleOut = join(work, "not-a-directory");
    writeFileSync(cfg, KONG_AUTH_ONLY);
    writeFileSync(impossibleOut, "occupied by a file");

    const result = await estate(
      "import",
      cfg,
      "--vendor",
      "kong",
      "--out",
      impossibleOut,
      "--json",
    );
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({
      receipt: {
        importId: expect.stringMatching(/^gwi-/),
        created: true,
        persisted: true,
      },
      output: { ok: false, installed: false, directory: impossibleOut },
    });
    expect(existsSync(join(work, ".anvil", "imports", report.receipt.importId))).toBe(true);
    expect(report).not.toHaveProperty("serviceId");
    expect(report).not.toHaveProperty("operations");
  });

  it("restores the prior bundle when immutable receipt persistence rejects the new import", async () => {
    const firstConfig = join(work, "kong-first.yaml");
    const secondConfig = join(work, "kong-second.yaml");
    const out = join(work, "bundle-transaction");
    const probeOut = join(work, "bundle-probe");
    writeFileSync(firstConfig, KONG_AUTH_ONLY);
    writeFileSync(secondConfig, `${KONG_AUTH_ONLY}\n# distinct exact export bytes\n`);

    const first = await estate("import", firstConfig, "--vendor", "kong", "--out", out, "--json");
    expect(first.code).toBe(0);
    const firstReport = JSON.parse(first.out);
    const priorAir = readFileSync(join(out, "air.yaml"));
    const priorView = readFileSync(join(out, "import.receipt.json"));

    // Materialize the second content-derived slot, then corrupt it so a later
    // create must reject it as a collision after the replacement was staged.
    const probe = await estate(
      "import",
      secondConfig,
      "--vendor",
      "kong",
      "--out",
      probeOut,
      "--json",
    );
    expect(probe.code).toBe(0);
    const probeReport = JSON.parse(probe.out);
    expect(probeReport.receipt.importId).not.toBe(firstReport.receipt.importId);
    const probeReceiptPath = join(probeReport.receipt.directory, "import.receipt.json");
    const corruptReceipt = JSON.parse(readFileSync(probeReceiptPath, "utf8"));
    corruptReceipt.inventory.digest = "corrupted";
    writeFileSync(probeReceiptPath, `${JSON.stringify(corruptReceipt, null, 2)}\n`);

    const replacement = await estate(
      "import",
      secondConfig,
      "--vendor",
      "kong",
      "--out",
      out,
      "--json",
    );
    expect(replacement.code).toBe(1);
    expect(JSON.parse(replacement.out)).toMatchObject({
      receipt: {
        importId: probeReport.receipt.importId,
        created: false,
        persisted: false,
      },
      output: {
        ok: false,
        installed: false,
        directory: out,
      },
      diagnostics: [expect.objectContaining({ code: "gateway_receipt/id_collision" })],
    });
    expect(readFileSync(join(out, "air.yaml"))).toEqual(priorAir);
    expect(readFileSync(join(out, "import.receipt.json"))).toEqual(priorView);
  });

  it("registers in the command tree with all subcommands", async () => {
    const io = bufferIO();
    const code = await runAnvilCli(["estate", "--help"], { io });
    expect(code).toBe(0);
    const help = io.stdout.join("\n");
    expect(help).toContain("inventory");
    expect(help).toContain("import");
    expect(help).toContain("verify");
  });
});
