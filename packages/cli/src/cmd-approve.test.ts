import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AirDocument, airFromJson } from "@anvil/air";
import { certifyBundle, readBundleDir } from "@anvil/generators";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { runApprove } from "./commands/approve.js";
import { bufferIO } from "./io.js";

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function compileBundle(): Promise<{ bundle: string; root: string; operation: string }> {
  const root = mkdtempSync(join(tmpdir(), "anvil-approve-"));
  roots.push(root);
  const bundle = join(root, "bundle");
  const io = bufferIO();
  const code = await runAnvilCli(
    [
      "compile",
      join(examples, "openapi.yaml"),
      "--service",
      "payments",
      "--out",
      bundle,
      "--root",
      join(root, "sources"),
      "--endpoint",
      "https://mcp.example.test/mcp",
    ],
    { io },
  );
  expect(code, io.text()).toBe(0);
  const air = airFromJson(readFileSync(join(bundle, "air.json"), "utf8"));
  const operation = air.operations.find((op) => op.state === "review_required")?.id;
  if (!operation) throw new Error("payments fixture has no review_required operation");
  return { bundle, root, operation };
}

function transactionLitter(root: string): string[] {
  return readdirSync(root).filter(
    (entry) =>
      entry.startsWith(".bundle.approve-stage-") || entry.startsWith(".bundle.approve-backup-"),
  );
}

function operationState(air: AirDocument, operation: string): string | undefined {
  return air.operations.find((op) => op.id === operation)?.state;
}

describe("anvil approve", () => {
  it("atomically re-projects one approval across AIR, CLI, MCP, runtime, and skill", async () => {
    const { bundle, root, operation } = await compileBundle();

    const inspect = bufferIO();
    expect(await runAnvilCli(["inspect", bundle], { io: inspect })).toBe(0);
    expect(inspect.text()).toContain(`id=${operation}`);

    const targetFile = join(bundle, "targets", "gemini-enterprise", "sentinel.txt");
    mkdirSync(join(targetFile, ".."), { recursive: true });
    writeFileSync(targetFile, "existing target kit\n", "utf8");
    writeFileSync(join(bundle, "certification.json"), '{"existing":"record"}\n', "utf8");
    const staleSkillFile = join(bundle, "skill", "examples", "stale-projection.json");
    mkdirSync(join(staleSkillFile, ".."), { recursive: true });
    writeFileSync(staleSkillFile, '{"stale":true}\n', "utf8");
    writeFileSync(join(bundle, "operator-notes.txt"), "preserve me\n", "utf8");

    const io = bufferIO();
    expect(await runAnvilCli(["approve", bundle, operation], { io })).toBe(0);
    expect(io.text()).toContain("atomically regenerated");
    expect(io.text()).toContain("were not regenerated and are now stale");

    const files = readBundleDir(bundle);
    for (const rel of ["air.json", "cli/air.json", "mcp/air.json", "runtime/air.json"]) {
      expect(operationState(airFromJson(files[rel] as string), operation), rel).toBe("approved");
    }

    const catalog = JSON.parse(files["catalog.json"] as string) as {
      operations: Array<{ id: string; state: string }>;
    };
    expect(catalog.operations.find((op) => op.id === operation)?.state).toBe("approved");

    const runtime = JSON.parse(files["runtime/operations.manifest.json"] as string) as {
      operations: Array<{ id: string }>;
    };
    expect(runtime.operations.map((op) => op.id)).toContain(operation);

    const canonical = airFromJson(files["air.json"] as string);
    const approved = canonical.operations.find((op) => op.id === operation);
    if (!approved) throw new Error(`missing approved operation ${operation}`);
    expect(files["skill/reference/operations.md"]).toContain(operation);
    expect(files[`skill/schemas/${approved.canonicalName}.schema.json`]).toBeDefined();
    expect(files[`skill/examples/${approved.canonicalName}.json`]).toBeDefined();

    const resources = JSON.parse(files["mcp/resources.json"] as string) as Array<{
      uri: string;
      text: string;
    }>;
    const install = resources.find((resource) => resource.uri.startsWith("anvil://cli/"));
    expect(install).toBeDefined();
    expect(JSON.parse(install?.text ?? "{}").connectsTo).toBe("https://mcp.example.test/mcp");

    const contractFailures = certifyBundle(files, canonical).checks.filter(
      (check) => check.gate === "contract" && check.status === "failed",
    );
    expect(contractFailures).toEqual([]);
    expect(readFileSync(targetFile, "utf8")).toBe("existing target kit\n");
    expect(readFileSync(join(bundle, "certification.json"), "utf8")).toBe(
      '{"existing":"record"}\n',
    );
    expect(files["skill/examples/stale-projection.json"]).toBeUndefined();
    expect(readFileSync(join(bundle, "operator-notes.txt"), "utf8")).toBe("preserve me\n");
    expect(transactionLitter(root)).toEqual([]);
  });

  it("rejects an unknown id before staging and leaves the bundle byte-for-byte unchanged", async () => {
    const { bundle, root } = await compileBundle();
    const before = readBundleDir(bundle);
    const io = bufferIO();

    expect(await runAnvilCli(["approve", bundle, "payments.unknown.operation"], { io })).toBe(1);
    expect(io.stderr.join("\n")).toContain("Unknown operation id");
    expect(readBundleDir(bundle)).toEqual(before);
    expect(transactionLitter(root)).toEqual([]);
  });

  it("restores the original bundle when the staged-directory install fails", async () => {
    const { bundle, root, operation } = await compileBundle();
    const before = readBundleDir(bundle);

    expect(() =>
      runApprove(bundle, [operation], bufferIO(), {
        installStagedBundle: () => {
          throw new Error("injected install failure");
        },
      }),
    ).toThrow("injected install failure");

    expect(readBundleDir(bundle)).toEqual(before);
    expect(transactionLitter(root)).toEqual([]);
  });
});
