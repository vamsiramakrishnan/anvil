import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceSnapshot } from "@anvil/compiler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const payments = join(examples, "payments/openapi.yaml");
const swagger = join(examples, "fixtures/petstore-swagger2.yaml");
const openapi31 = join(examples, "fixtures/tasks-openapi31.json");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "anvil-source-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Run `anvil source ...` against the temp workspace, returning code + parsed --json. */
async function source(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(["source", ...argv, "--root", root], { io });
  return { code, io };
}

async function addJson(path: string, ...extra: string[]) {
  const { code, io } = await source("add", path, "--json", ...extra);
  expect(code).toBe(0);
  return JSON.parse(io.stdout.join("\n")) as {
    snapshot: SourceSnapshot;
    diagnostics: unknown[];
  };
}

describe("anvil source add", () => {
  it("imports and locks an OpenAPI 3.0 YAML spec", async () => {
    const { snapshot } = await addJson(payments);
    expect(snapshot.kind).toBe("openapi");
    expect(snapshot.files[0]?.detected).toEqual({ kind: "openapi", version: "3.0" });
    // The lock is source.json + a byte-identical verbatim copy under raw/.
    const dir = join(root, ".anvil", "sources", snapshot.id);
    const stored = JSON.parse(readFileSync(join(dir, "source.json"), "utf8"));
    expect(stored.sourceHash).toBe(snapshot.sourceHash);
    expect(readFileSync(join(dir, "raw", "openapi.yaml"), "utf8")).toBe(
      readFileSync(payments, "utf8"),
    );
  });

  it("imports OpenAPI 3.1 JSON and Swagger 2.0 YAML with correct detection", async () => {
    const tasks = await addJson(openapi31);
    expect(tasks.snapshot.kind).toBe("openapi");
    expect(tasks.snapshot.files[0]?.detected).toEqual({ kind: "openapi", version: "3.1" });
    const pets = await addJson(swagger);
    expect(pets.snapshot.kind).toBe("swagger");
    expect(pets.snapshot.files[0]?.detected).toEqual({ kind: "swagger", version: "2.0" });
  });

  it("re-importing unchanged content produces the same sourceHash", async () => {
    const first = await addJson(payments, "--id", "payments");
    const second = await addJson(payments, "--id", "payments");
    expect(second.snapshot.sourceHash).toBe(first.snapshot.sourceHash);
  });

  it("imports a directory of specs as one snapshot with multiple files", async () => {
    const dir = join(root, "specs");
    mkdirSync(join(dir, "nested"), { recursive: true });
    cpSync(payments, join(dir, "openapi.yaml"));
    cpSync(swagger, join(dir, "nested", "petstore.yaml"));
    const { snapshot } = await addJson(dir, "--id", "combined");
    expect(snapshot.files.map((f) => f.path)).toEqual(["nested/petstore.yaml", "openapi.yaml"]);
    expect(snapshot.kind).toBe("openapi");
    expect(
      readFileSync(join(root, ".anvil/sources/combined/raw/nested/petstore.yaml"), "utf8"),
    ).toBe(readFileSync(swagger, "utf8"));
  });

  it("rejects a broken spec with structured diagnostics and a non-zero exit", async () => {
    const broken = join(root, "broken.yaml");
    writeFileSync(broken, "openapi: [3.0.0\n  nope: {", "utf8");
    const { code, io } = await source("add", broken);
    expect(code).toBe(1);
    expect(io.text()).toContain("source/unparseable");
    // Nothing may be locked from a failed import.
    const listed = await source("list", "--json");
    expect(JSON.parse(listed.io.stdout.join("\n"))).toEqual([]);
  });

  it("rejects an unknown --kind", async () => {
    const { code, io } = await source("add", payments, "--kind", "not_a_gateway");
    expect(code).toBe(1);
    expect(io.text()).toContain("source/unknown_kind");
  });
});

describe("anvil source list / show", () => {
  it("lists locked snapshots and shows one in detail", async () => {
    await addJson(payments, "--id", "payments");
    const list = await source("list");
    expect(list.code).toBe(0);
    expect(list.io.text()).toContain("payments");
    const show = await source("show", "payments");
    expect(show.code).toBe(0);
    expect(show.io.text()).toContain("openapi 3.0 (yaml)");
    expect(show.io.text()).toContain("sourceHash: sha256:");
  });

  it("show of an unknown id exits non-zero", async () => {
    const { code, io } = await source("show", "ghost");
    expect(code).toBe(1);
    expect(io.text()).toContain("source/not_found");
  });
});

describe("anvil source validate", () => {
  it("confirms an intact snapshot", async () => {
    await addJson(payments, "--id", "payments");
    const { code, io } = await source("validate", "payments");
    expect(code).toBe(0);
    expect(io.text()).toContain("intact");
  });

  it("detects a tampered raw file", async () => {
    await addJson(payments, "--id", "payments");
    const raw = join(root, ".anvil/sources/payments/raw/openapi.yaml");
    writeFileSync(raw, `${readFileSync(raw, "utf8")}\n# tampered\n`, "utf8");
    const { code, io } = await source("validate", "payments");
    expect(code).toBe(1);
    expect(io.text()).toContain("source/file_changed");
  });
});

describe("anvil source usage", () => {
  it("bare `anvil source` prints subcommand usage and exits 0", async () => {
    const io = bufferIO();
    const code = await runAnvilCli(["source"], { io });
    expect(code).toBe(0);
    expect(io.text()).toContain("anvil source add");
    expect(io.text()).toContain("anvil source validate");
  });

  it("an unknown subcommand exits non-zero", async () => {
    const io = bufferIO();
    const code = await runAnvilCli(["source", "frobnicate"], { io });
    expect(code).toBe(1);
    expect(io.text()).toContain("Unknown source subcommand");
  });
});
