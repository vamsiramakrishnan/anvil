import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { compileBundle } from "./api.js";
import { bufferIO } from "./io.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "anvil-schema-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("anvil schema manifest", () => {
  it("prints the manifest's JSON Schema, derived from the compiler's own definition", async () => {
    const io = bufferIO();
    const code = await runAnvilCli(["schema", "manifest"], { io });
    expect(code).toBe(0);
    const schema = JSON.parse(io.stdout.join("\n")) as {
      $id: string;
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.$id).toContain("anvil-manifest.schema.json");
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(["operations", "workflows", "capabilities", "query_templates"]),
    );
  });

  it("writes the schema to --out and says so on stderr, never stdout", async () => {
    const out = join(root, "schemas", "anvil-manifest.schema.json");
    const io = bufferIO();
    const code = await runAnvilCli(["schema", "manifest", "--out", out], { io });
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(io.stdout.join("")).toBe("");
    expect(io.stderr.join("\n")).toContain(out);
    expect(JSON.parse(readFileSync(out, "utf8"))).toHaveProperty("properties.operations");
  });
});

describe("the checked-in manifest schema", () => {
  it("is byte-identical to a fresh `anvil schema manifest` (regenerate and commit when this fails)", async () => {
    const checkedIn = readFileSync(
      fileURLToPath(new URL("../../../schemas/anvil-manifest.schema.json", import.meta.url)),
      "utf8",
    );
    const io = bufferIO();
    expect(await runAnvilCli(["schema", "manifest"], { io })).toBe(0);
    expect(checkedIn).toBe(`${io.stdout.join("\n")}\n`);
  });
});

describe("compileBundle — Anvil as a library", () => {
  it("locks, compiles, generates, and installs exactly as `anvil compile` does", async () => {
    const out = join(root, "generated", "payments");
    const result = await compileBundle({
      spec: join(examples, "payments", "openapi.yaml"),
      manifest: join(examples, "payments", "anvil.yaml"),
      serviceId: "payments",
      out,
      root,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.air.service.id).toBe("payments");
    expect(result.snapshotId).toMatch(/^src_|^[a-z0-9_-]+$/);
    expect(result.written.length).toBeGreaterThan(20);
    expect(existsSync(join(out, "air.yaml"))).toBe(true);
    expect(existsSync(join(out, "mcp", "server.js"))).toBe(true);
    expect(result.diagnostics.filter((d) => d.level === "error")).toEqual([]);
  });

  it("refuses a missing manifest and an invalid one before locking anything else", async () => {
    const missing = await compileBundle({
      spec: join(examples, "payments", "openapi.yaml"),
      manifest: join(root, "nope.yaml"),
      out: join(root, "out"),
      root,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.stage).toBe("manifest");
      expect(missing.diagnostics[0]?.code).toBe("manifest/not_found");
    }
    const manifest = join(root, "anvil.yaml");
    writeFileSync(
      manifest,
      "operations:\n  createRefund:\n    idempotancy: { strategy: natural }\n",
    );
    const invalid = await compileBundle({
      spec: join(examples, "payments", "openapi.yaml"),
      manifest,
      out: join(root, "out"),
      root,
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.stage).toBe("manifest");
      expect(invalid.diagnostics[0]?.code).toBe("manifest/invalid");
      expect(invalid.diagnostics[0]?.message).toContain(`${manifest}:3:5`);
      expect(invalid.manifestIssues?.[0]?.suggestion).toBe("idempotency");
    }
    expect(existsSync(join(root, "out"))).toBe(false);
  });
});
