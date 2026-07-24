import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";

/**
 * `anvil estate` — targeted coverage of guard clauses and error/failure
 * branches that packages/cli/src/cmd-estate*.test.ts and friends do not
 * already exercise: invalid CLI args, missing/malformed manifests and
 * baselines, approval-gated bundle-install collisions, and drift/import
 * failure modes.
 *
 * Nothing in packages/cli/src/commands/estate.ts is exported besides
 * `registerEstate` and `gatewayIdentityDiagnostics` (the latter already has
 * dedicated coverage in estate-identity.test.ts), so every case here drives
 * the real CLI end-to-end through `runAnvilCli`, matching the repo's existing
 * idiom for this file.
 */

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

const KONG_NO_ROUTES = `_format_version: "3.0"
services:
  - name: empty-api
    url: https://backend.internal/empty
    routes: []
`;

const REFUNDS_OPENAPI = `openapi: "3.0.3"
info: { title: Refunds, version: "1.0.0" }
paths:
  /refunds/{id}:
    get:
      operationId: fetchRefund
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
`;

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-bugbash-"));
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

describe("anvil estate — unknown vendor guard across subcommands", () => {
  it.each([
    "connect",
    "audit",
    "plan",
    "import",
  ])("estate %s reports estate/unknown_vendor before touching the export", async (subcommand) => {
    const missing = join(work, "does-not-exist.yaml");
    const result = await estate(subcommand, missing, "--vendor", "nginx", "--json");
    expect(result.code).toBe(1);
    expect(result.err).toBe("");
    expect(JSON.parse(result.out)).toMatchObject({
      schemaVersion: 1,
      reportType: "anvil.gateway-estate-error",
      code: "estate/unknown_vendor",
      message: expect.stringContaining("kong"),
    });
  });
});

describe("anvil estate — invalid --gateway-id guard", () => {
  it("inventory rejects an empty --gateway-id in both text and json modes", async () => {
    const cfg = join(work, "kong.yaml");
    writeFileSync(cfg, kongConfig("alpha", "/alpha"));

    const text = await estate("inventory", cfg, "--vendor", "kong", "--gateway-id", " ");
    expect(text.code).toBe(1);
    expect(text.err).toContain("Invalid --gateway-id");
    expect(text.err).toContain("non-empty");

    const json = await estate("inventory", cfg, "--vendor", "kong", "--gateway-id", " ", "--json");
    expect(json.code).toBe(1);
    expect(json.err).toBe("");
    expect(JSON.parse(json.out)).toMatchObject({
      reportType: "anvil.gateway-estate-inventory-error",
      code: "estate/invalid_gateway_id",
    });
  });

  it("rejects the reserved 'unscoped' --gateway-id value case-insensitively", async () => {
    const cfg = join(work, "kong.yaml");
    writeFileSync(cfg, kongConfig("alpha", "/alpha"));

    const connect = await estate(
      "connect",
      cfg,
      "--vendor",
      "kong",
      "--gateway-id",
      "UNSCOPED",
      "--json",
    );
    expect(connect.code).toBe(1);
    expect(JSON.parse(connect.out)).toMatchObject({
      reportType: "anvil.gateway-estate-connect-error",
      code: "estate/invalid_gateway_id",
      message: expect.stringContaining("reserved"),
    });

    const audit = await estate("audit", cfg, "--vendor", "kong", "--gateway-id", "unscoped");
    expect(audit.code).toBe(1);
    expect(audit.err).toContain("reserved");
  });

  it("import rejects an invalid --gateway-id only after the export loads", async () => {
    const cfg = join(work, "kong.yaml");
    writeFileSync(cfg, kongConfig("alpha", "/alpha"));
    const out = join(work, "bundle");

    const result = await estate(
      "import",
      cfg,
      "--vendor",
      "kong",
      "--gateway-id",
      "unscoped",
      "--out",
      out,
      "--json",
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      reportType: "anvil.gateway-estate-import-error",
      code: "gateway_selection/invalid_gateway_id",
    });
    expect(existsSync(out)).toBe(false);
  });
});

describe("anvil estate inventory — invalid --limit guard", () => {
  it.each([
    "0",
    "10001",
    "abc",
    "-5",
  ])("rejects --limit %s only after the inventory itself resolves", async (limit) => {
    const cfg = join(work, "kong.yaml");
    writeFileSync(cfg, kongConfig("alpha", "/alpha"));
    const result = await estate("inventory", cfg, "--vendor", "kong", "--limit", limit, "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      reportType: "anvil.gateway-estate-inventory-error",
      code: "estate/invalid_limit",
    });
  });

  it("accepts the boundary values 1 and 10000", async () => {
    const cfg = join(work, "kong.yaml");
    writeFileSync(cfg, kongConfig("alpha", "/alpha"));
    const low = await estate("inventory", cfg, "--vendor", "kong", "--limit", "1", "--json");
    expect(low.code).toBe(0);
    const high = await estate("inventory", cfg, "--vendor", "kong", "--limit", "10000", "--json");
    expect(high.code).toBe(0);
  });
});

describe("anvil estate audit — invalid --fail-on guard", () => {
  it("rejects an unknown --fail-on value before touching the export", async () => {
    const missing = join(work, "does-not-exist.yaml");
    const text = await estate("audit", missing, "--vendor", "kong", "--check", "--fail-on", "yolo");
    expect(text.code).toBe(1);
    expect(text.err).toContain("--fail-on");
    expect(text.err).toContain("blocked | review-required");

    const json = await estate(
      "audit",
      missing,
      "--vendor",
      "kong",
      "--check",
      "--fail-on",
      "yolo",
      "--json",
    );
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({
      reportType: "anvil.gateway-estate-audit-error",
      code: "estate/invalid_fail_on",
    });
  });
});

describe("anvil estate plan — cheap guard clauses (no export ever read)", () => {
  it("requires --baseline with --check", async () => {
    const missing = join(work, "does-not-exist.yaml");
    const result = await estate("plan", missing, "--vendor", "kong", "--check", "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      reportType: "anvil.gateway-estate-adoption-plan-error",
      code: "estate/baseline_required",
    });
  });

  it.each([
    ["--selection", join("some", "selection.yaml")],
    ["--baseline", join("some", "baseline.json")],
  ])("refuses --init-selection combined with %s", async (flag, value) => {
    const missing = join(work, "does-not-exist.yaml");
    const initSelection = join(work, "selection-init.yaml");
    const result = await estate(
      "plan",
      missing,
      "--vendor",
      "kong",
      "--init-selection",
      initSelection,
      flag,
      value,
      "--json",
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      code: "estate/selection_init_conflict",
    });
  });

  it("refuses --init-selection combined with --select", async () => {
    const missing = join(work, "does-not-exist.yaml");
    const initSelection = join(work, "selection-init.yaml");
    const result = await estate(
      "plan",
      missing,
      "--vendor",
      "kong",
      "--init-selection",
      initSelection,
      "--select",
      "some-api",
      "--json",
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      code: "estate/selection_init_conflict",
    });
  });

  it("refuses to overwrite an existing --init-selection file", async () => {
    const missing = join(work, "does-not-exist.yaml");
    const initSelection = join(work, "already-there.yaml");
    writeFileSync(initSelection, "schemaVersion: 1\napis: []\n");
    const result = await estate(
      "plan",
      missing,
      "--vendor",
      "kong",
      "--init-selection",
      initSelection,
      "--json",
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      code: "estate/selection_overwrite",
      message: expect.stringContaining(initSelection),
    });
  });

  it("refuses --init-selection and --out pointing at the same file", async () => {
    const missing = join(work, "does-not-exist.yaml");
    const shared = join(work, "shared.yaml");
    const result = await estate(
      "plan",
      missing,
      "--vendor",
      "kong",
      "--init-selection",
      shared,
      "--out",
      shared,
      "--json",
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      code: "estate/output_path_collision",
    });
  });

  it("refuses --out overwriting the reviewed --baseline", async () => {
    const missing = join(work, "does-not-exist.yaml");
    const shared = join(work, "shared-plan.json");
    const result = await estate(
      "plan",
      missing,
      "--vendor",
      "kong",
      "--out",
      shared,
      "--baseline",
      shared,
      "--json",
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      code: "estate/baseline_overwrite",
    });
  });
});

describe("anvil estate plan — malformed --baseline/--selection files", () => {
  it("wraps an unparseable --baseline JSON file as estate/adoption_plan_failed", async () => {
    const cfg = join(work, "kong.yaml");
    writeFileSync(cfg, kongConfig("alpha", "/alpha"));
    const baseline = join(work, "baseline.json");
    writeFileSync(baseline, "{not valid json");
    const result = await estate("plan", cfg, "--vendor", "kong", "--baseline", baseline, "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      code: "estate/adoption_plan_failed",
      message: expect.stringContaining(baseline),
    });
  });

  it("rejects a well-formed but schema-invalid --baseline as estate/invalid_baseline", async () => {
    const cfg = join(work, "kong.yaml");
    writeFileSync(cfg, kongConfig("alpha", "/alpha"));
    const baseline = join(work, "baseline.json");
    writeFileSync(baseline, "{}");
    const result = await estate("plan", cfg, "--vendor", "kong", "--baseline", baseline, "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      code: "estate/invalid_baseline",
    });
  });

  it("rejects a well-formed but schema-invalid --selection as estate/invalid_selection", async () => {
    const cfg = join(work, "kong.yaml");
    writeFileSync(cfg, kongConfig("alpha", "/alpha"));
    const selection = join(work, "selection.yaml");
    writeFileSync(selection, "not: a-selection-document\n");
    const result = await estate(
      "plan",
      cfg,
      "--vendor",
      "kong",
      "--selection",
      selection,
      "--json",
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      code: "estate/invalid_selection",
    });
  });
});

describe("anvil estate import — spec/attestation guard clauses (no export ever read)", () => {
  it("requires --spec before accepting --attest-spec-override", async () => {
    const missing = join(work, "does-not-exist.yaml");
    const result = await estate(
      "import",
      missing,
      "--vendor",
      "wso2",
      "--attest-spec-override",
      "a legitimate reason",
      "--json",
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      reportType: "anvil.gateway-estate-import-error",
      code: "gateway/spec_override_without_spec",
    });
  });

  it("restricts --attest-spec-override to the wso2 vendor", async () => {
    const missing = join(work, "does-not-exist.yaml");
    const spec = join(work, "does-not-exist-spec.yaml");
    const result = await estate(
      "import",
      missing,
      "--vendor",
      "kong",
      "--spec",
      spec,
      "--attest-spec-override",
      "a legitimate reason",
      "--json",
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      code: "gateway/spec_override_wrong_vendor",
    });
  });

  it("rejects an empty --attest-spec-override reason", async () => {
    const missing = join(work, "does-not-exist.yaml");
    const spec = join(work, "does-not-exist-spec.yaml");
    const result = await estate(
      "import",
      missing,
      "--vendor",
      "wso2",
      "--spec",
      spec,
      "--attest-spec-override",
      "   ",
      "--json",
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      code: "gateway/invalid_spec_override_attestation",
    });
  });

  it("rejects an --attest-spec-override reason over 2000 characters", async () => {
    const missing = join(work, "does-not-exist.yaml");
    const spec = join(work, "does-not-exist-spec.yaml");
    const result = await estate(
      "import",
      missing,
      "--vendor",
      "wso2",
      "--spec",
      spec,
      "--attest-spec-override",
      "x".repeat(2_001),
      "--json",
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      code: "gateway/invalid_spec_override_attestation",
    });
  });
});

describe("anvil estate import — --gateway-url guard clauses (no export ever read)", () => {
  it("rejects an unparseable --gateway-url", async () => {
    const missing = join(work, "does-not-exist.yaml");
    const result = await estate(
      "import",
      missing,
      "--vendor",
      "kong",
      "--gateway-url",
      "not a url",
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain("expected an absolute HTTPS URL");
  });

  it("rejects a --gateway-url carrying embedded credentials", async () => {
    const missing = join(work, "does-not-exist.yaml");
    const result = await estate(
      "import",
      missing,
      "--vendor",
      "kong",
      "--gateway-url",
      "https://user:pass@gateway.example.test",
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain("embedded credentials are not allowed");
  });

  it("rejects a --gateway-url with a query string", async () => {
    const missing = join(work, "does-not-exist.yaml");
    const result = await estate(
      "import",
      missing,
      "--vendor",
      "kong",
      "--gateway-url",
      "https://gateway.example.test/base?x=1",
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain("query strings and fragments are not allowed");
  });

  it("rejects a --gateway-url with a fragment", async () => {
    const missing = join(work, "does-not-exist.yaml");
    const result = await estate(
      "import",
      missing,
      "--vendor",
      "kong",
      "--gateway-url",
      "https://gateway.example.test/base#section",
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain("query strings and fragments are not allowed");
  });
});

describe("anvil estate import — --manifest guard clauses (no export ever read)", () => {
  it("reports an unreadable --manifest path", async () => {
    const missing = join(work, "does-not-exist.yaml");
    const manifest = join(work, "no-such-manifest.yaml");
    const result = await estate("import", missing, "--vendor", "kong", "--manifest", manifest);
    expect(result.code).toBe(1);
    expect(result.err).toContain("Cannot read or parse --manifest");
    expect(result.err).toContain(manifest);
  });

  it("reports a schema-invalid --manifest", async () => {
    const missing = join(work, "does-not-exist.yaml");
    const manifest = join(work, "bad-manifest.yaml");
    writeFileSync(manifest, "operations: not-a-map\n");
    const result = await estate("import", missing, "--vendor", "kong", "--manifest", manifest);
    expect(result.code).toBe(1);
    expect(result.err).toContain("Cannot read or parse --manifest");
  });
});

describe("anvil estate import — guard clauses after the export loads", () => {
  it("requires --gateway-id before accepting --strict-identity", async () => {
    const cfg = join(work, "kong.yaml");
    writeFileSync(cfg, kongConfig("alpha", "/alpha"));
    const out = join(work, "bundle");
    const result = await estate(
      "import",
      cfg,
      "--vendor",
      "kong",
      "--strict-identity",
      "--out",
      out,
      "--json",
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      code: "gateway_selection/gateway_id_required",
    });
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a manifest service.environment that conflicts with the selected coordinate", async () => {
    const cfg = join(work, "kong-empty.yaml");
    writeFileSync(cfg, KONG_NO_ROUTES);
    const manifest = join(work, "env-conflict.anvil.yaml");
    writeFileSync(manifest, "service:\n  environment: staging\n");
    const out = join(work, "bundle-env-conflict");

    const result = await estate(
      "import",
      cfg,
      "--vendor",
      "kong",
      "--manifest",
      manifest,
      "--out",
      out,
      "--json",
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      code: "gateway_selection/environment_conflict",
      message: expect.stringContaining("staging"),
    });
    expect(existsSync(out)).toBe(false);
  });

  it("stops on a globally ambiguous/invalid inventory before selection is attempted", async () => {
    const cfg = join(work, "kong-openapi.yaml");
    writeFileSync(cfg, REFUNDS_OPENAPI);
    const out = join(work, "bundle-global-error");
    const result = await estate("import", cfg, "--vendor", "kong", "--out", out);
    expect(result.code).toBe(1);
    expect(result.err).toContain("The gateway inventory is ambiguous or invalid");
    expect(existsSync(out)).toBe(false);
  });
});

describe("anvil estate import — bundle-install collision guards", () => {
  it("refuses an unsafe root output path without touching the filesystem", async () => {
    const cfg = join(work, "kong.yaml");
    writeFileSync(cfg, kongConfig("alpha", "/alpha"));
    const result = await estate("import", cfg, "--vendor", "kong", "--out", "/", "--json");
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "gateway_receipt/unsafe_output_path" }),
      ]),
    );
  });

  it("refuses installing over a path that is a plain file", async () => {
    const cfg = join(work, "kong.yaml");
    writeFileSync(cfg, kongConfig("alpha", "/alpha"));
    const outPath = join(work, "occupied");
    writeFileSync(outPath, "occupied by a plain file");
    const result = await estate("import", cfg, "--vendor", "kong", "--out", outPath, "--json");
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "gateway_receipt/output_not_directory" }),
      ]),
    );
  });

  it("refuses installing over an unmanaged directory with no receipt view", async () => {
    const cfg = join(work, "kong.yaml");
    writeFileSync(cfg, kongConfig("alpha", "/alpha"));
    const outDir = join(work, "unmanaged");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "notes.txt"), "not an anvil-managed bundle");
    const result = await estate("import", cfg, "--vendor", "kong", "--out", outDir, "--json");
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "gateway_receipt/unmanaged_output" }),
      ]),
    );
    expect(readFileSync(join(outDir, "notes.txt"), "utf8")).toBe("not an anvil-managed bundle");
  });

  it("refuses installing when an existing receipt view does not match any stored receipt", async () => {
    const cfgA = join(work, "kong-a.yaml");
    writeFileSync(cfgA, kongConfig("victim", "/victim"));
    const outA = join(work, "bundle-victim");
    const first = await estate("import", cfgA, "--vendor", "kong", "--out", outA, "--json");
    expect(first.code, first.err).toBe(0);

    const realView = JSON.parse(readFileSync(join(outA, "import.receipt.json"), "utf8"));
    const outB = join(work, "bundle-forged");
    mkdirSync(outB);
    const forgedView = { ...realView, importId: "gwi-deadbeefdeadbeef" };
    writeFileSync(join(outB, "import.receipt.json"), JSON.stringify(forgedView, null, 2));

    const cfgB = join(work, "kong-b.yaml");
    writeFileSync(cfgB, kongConfig("intruder", "/intruder"));
    const second = await estate("import", cfgB, "--vendor", "kong", "--out", outB, "--json");
    expect(second.code).toBe(1);
    const report = JSON.parse(second.out);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "gateway_receipt/untrusted_output" }),
      ]),
    );
  });

  it("refuses a reimport when the existing installed bundle was tampered with", async () => {
    const cfg = join(work, "kong-tamper.yaml");
    writeFileSync(cfg, kongConfig("tamperable", "/tamperable"));
    const out = join(work, "bundle-tamperable");
    const args = ["import", cfg, "--vendor", "kong", "--out", out, "--json"];

    const first = await estate(...args);
    expect(first.code, first.err).toBe(0);
    expect(existsSync(join(out, "skill", "SKILL.md"))).toBe(true);

    writeFileSync(join(out, "skill", "SKILL.md"), "# tampered\nnot the generated content\n");

    const second = await estate(...args);
    expect(second.code).toBe(1);
    const report = JSON.parse(second.out);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "gateway_receipt/prior_output_changed" }),
      ]),
    );
  });
});

describe("anvil estate — export loading guard clauses", () => {
  it("refuses a directory export for a non-wso2 vendor", async () => {
    const dir = join(work, "some-directory");
    mkdirSync(dir);
    const result = await estate("inventory", dir, "--vendor", "kong");
    expect(result.code).toBe(1);
    expect(result.err).toContain("is a directory");
    expect(result.err).toContain("--vendor wso2");
  });

  it("refuses --entry combined with a wso2 collection directory", async () => {
    const dir = join(work, "wso2-collection");
    mkdirSync(dir);
    const result = await estate("inventory", dir, "--vendor", "wso2", "--entry", "whatever.yaml");
    expect(result.code).toBe(1);
    expect(result.err).toContain("--entry");
    expect(result.err).toContain("does not select an API from a WSO2 apictl collection");
  });

  it("refuses an empty wso2 apictl collection directory", async () => {
    const dir = join(work, "empty-wso2-collection");
    mkdirSync(dir);
    const result = await estate("inventory", dir, "--vendor", "wso2");
    expect(result.code).toBe(1);
    expect(result.err).toContain("wso2/empty_apictl_collection");
  });

  it("refuses a gzip container with no decoder, reported not silently ignored", async () => {
    const file = join(work, "export.tar.gz");
    writeFileSync(file, Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]));
    const result = await estate("inventory", file, "--vendor", "kong");
    expect(result.code).toBe(1);
    expect(result.err).toContain("gzip container");
    expect(result.err).toContain("no decoder yet");
  });

  it("refuses non-UTF-8 bytes that are also not a ZIP archive", async () => {
    const file = join(work, "binary.bin");
    writeFileSync(file, Uint8Array.from([0xff, 0xfe, 0x00, 0x01, 0xc0, 0xc1]));
    const result = await estate("inventory", file, "--vendor", "kong");
    expect(result.code).toBe(1);
    expect(result.err).toContain("not valid UTF-8 text");
  });

  it("refuses a ZIP archive with no config-like entry", async () => {
    const zipPath = join(work, "no-config.zip");
    writeFileSync(zipPath, zipSync({ "readme.txt": strToU8("hello") }));
    const result = await estate("inventory", zipPath, "--vendor", "kong");
    expect(result.code).toBe(1);
    expect(result.err).toContain("Archive has no config-like entry");
    expect(result.err).toContain("--entry");
  });

  it("names the available entries when --entry does not match any archive member", async () => {
    const zipPath = join(work, "one-entry.zip");
    writeFileSync(zipPath, zipSync({ "kong/kong.yaml": strToU8(kongConfig("alpha", "/alpha")) }));
    const result = await estate(
      "inventory",
      zipPath,
      "--vendor",
      "kong",
      "--entry",
      "wrong/path.yaml",
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain("Archive has no entry 'wrong/path.yaml'");
    expect(result.err).toContain("kong/kong.yaml");
  });

  it("recognizes a bare (non-archive) API Connect product document as native", async () => {
    const file = join(work, "product.yaml");
    writeFileSync(
      file,
      `product: 1.0.0
info: { name: orders-product, version: "1" }
apis: { orders: { $ref: orders-api.yaml } }
plans: {}
`,
    );
    const result = await estate("inventory", file, "--vendor", "api_connect", "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      code: "gateway/unsupported_native_artifact",
      message: expect.stringContaining("Product YAML with referenced APIs"),
    });
  });
});

describe("anvil estate verify — unknown import id", () => {
  it("reports a structured not-found diagnostic instead of throwing", async () => {
    const result = await estate("verify", "gwi-deadbeefdeadbeef", "--json");
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report.ok).toBe(false);
    expect(report.receipt.ok).toBe(false);
    expect(report.receipt.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "gateway_receipt/not_found" })]),
    );
  });

  it("reports an invalid-id diagnostic for a malformed import id, never a crash", async () => {
    const result = await estate("verify", "not-a-valid-id", "--json");
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report.receipt.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "gateway_receipt/invalid_id" })]),
    );
  });
});
