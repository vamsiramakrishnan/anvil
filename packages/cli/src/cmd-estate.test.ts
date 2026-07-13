import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-estate-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

async function estate(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(["estate", ...argv], { io });
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
    // The unknown plugin must surface as an opaque policy, never vanish.
    expect(res.out).toMatch(/opaque/i);
  });

  it("imports the same config from inside a real ZIP archive", async () => {
    const zipPath = join(work, "export.zip");
    writeFileSync(zipPath, zipSync({ "kong/kong.yaml": strToU8(KONG_ONE_SERVICE) }));
    const out = join(work, "bundle-zip");
    const res = await estate("import", zipPath, "--vendor", "kong", "--out", out);
    expect(res.code).toBe(0);
    expect(existsSync(join(out, "catalog.json"))).toBe(true);
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

  it("registers in the command tree with both subcommands", async () => {
    const io = bufferIO();
    const code = await runAnvilCli(["estate", "--help"], { io });
    expect(code).toBe(0);
    const help = io.stdout.join("\n");
    expect(help).toContain("inventory");
    expect(help).toContain("import");
  });
});
