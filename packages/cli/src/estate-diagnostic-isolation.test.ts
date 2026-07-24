import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

const KONG_WITH_DUPLICATE_SIBLING = `_format_version: "3.0"
services:
  - name: good-a
    routes:
      - name: list-good
        paths: ["/good"]
        methods: ["GET"]
  - name: duplicate-b
    routes:
      - name: list-b-one
        paths: ["/b/one"]
        methods: ["GET"]
  - name: duplicate-b
    routes:
      - name: list-b-two
        paths: ["/b/two"]
        methods: ["GET"]
`;

interface CliResult {
  code: number;
  out: string;
  err: string;
}

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-diagnostic-isolation-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function estate(...args: string[]): Promise<CliResult> {
  const io = bufferIO();
  const code = await runAnvilCli(["estate", ...args], { io });
  return {
    code,
    out: io.stdout.join("\n"),
    err: io.stderr.join("\n"),
  };
}

describe("gateway diagnostic ownership isolation", () => {
  it("does not let duplicate API B poison valid API A", async () => {
    const exportPath = join(work, "kong.yaml");
    const goodOut = join(work, "good-a-bundle");
    const badOut = join(work, "duplicate-b-bundle");
    writeFileSync(exportPath, KONG_WITH_DUPLICATE_SIBLING);

    const auditResult = await estate("audit", exportPath, "--vendor", "kong", "--json");
    expect(auditResult.code, auditResult.err).toBe(0);
    const audit = JSON.parse(auditResult.out);
    const goodAudits = audit.apis.filter((api: { id: string }) => api.id === "good-a");
    const duplicateAudits = audit.apis.filter((api: { id: string }) => api.id === "duplicate-b");
    expect(goodAudits).toHaveLength(1);
    expect(goodAudits[0].disposition).not.toBe("blocked");
    expect(goodAudits[0].reasons).not.toContain("gateway/duplicate_api_coordinate");
    expect(duplicateAudits).toHaveLength(2);
    expect(
      duplicateAudits.every((api: { disposition: string }) => api.disposition === "blocked"),
    ).toBe(true);
    expect(
      duplicateAudits.every((api: { reasons: string[] }) =>
        api.reasons.includes("gateway/duplicate_api_coordinate"),
      ),
    ).toBe(true);
    const duplicateFindings = audit.findings.filter(
      (finding: { code: string }) => finding.code === "gateway/duplicate_api_coordinate",
    );
    expect(duplicateFindings).toHaveLength(1);
    expect(duplicateFindings[0]).toMatchObject({
      severity: "blocking",
      scope: { kind: "api" },
      owner: "gateway_owner",
    });
    expect(duplicateFindings[0].scope.id).toContain("duplicate-b");

    const goodImport = await estate(
      "import",
      exportPath,
      "--vendor",
      "kong",
      "--api",
      "good-a",
      "--out",
      goodOut,
      "--root",
      work,
      "--json",
    );
    expect(goodImport.code, `${goodImport.err}\n${goodImport.out}`).toBe(0);
    expect(existsSync(goodOut)).toBe(true);
    expect(
      JSON.parse(goodImport.out).diagnostics.some(
        (diagnostic: { code: string }) => diagnostic.code === "gateway/duplicate_api_coordinate",
      ),
    ).toBe(false);

    const badImport = await estate(
      "import",
      exportPath,
      "--vendor",
      "kong",
      "--api",
      "duplicate-b",
      "--out",
      badOut,
      "--root",
      work,
      "--json",
    );
    expect(badImport.code).toBe(1);
    expect(existsSync(badOut)).toBe(false);
    expect(JSON.parse(badImport.out).code).toBe("gateway_selection/ambiguous");
  });

  it("keeps a whole-document parse error global and fail-closed", async () => {
    const exportPath = join(work, "invalid-kong.yaml");
    const out = join(work, "invalid-bundle");
    writeFileSync(exportPath, "_format_version: '3.0'\nservices: [");

    const result = await estate(
      "import",
      exportPath,
      "--vendor",
      "kong",
      "--api",
      "anything",
      "--out",
      out,
      "--root",
      work,
    );
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/inventory is ambiguous or invalid/i);
    expect(existsSync(out)).toBe(false);
  });
});
