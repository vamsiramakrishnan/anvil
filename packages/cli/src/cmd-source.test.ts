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

/** Run `anvil source ...` against the temp workspace, returning code + io. */
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
    dir: string;
    created: boolean;
    diagnostics: unknown[];
  };
}

describe("anvil source add", () => {
  it("imports and locks an OpenAPI 3.0 YAML spec byte-identically", async () => {
    const { snapshot } = await addJson(payments);
    expect(snapshot.status).toBe("valid");
    expect(snapshot.origin).toEqual({ kind: "filesystem", uri: payments });
    expect(snapshot.entrypoints).toEqual([
      { path: "openapi.yaml", format: "openapi", version: "3.0" },
    ]);
    // The lock is source.json + a byte-identical verbatim copy under raw/.
    const dir = join(root, ".anvil", "sources", snapshot.snapshotId);
    const stored = JSON.parse(readFileSync(join(dir, "source.json"), "utf8"));
    expect(stored.sourceHash).toBe(snapshot.sourceHash);
    expect(readFileSync(join(dir, "raw", "openapi.yaml")).equals(readFileSync(payments))).toBe(
      true,
    );
  });

  it("imports OpenAPI 3.1 JSON and Swagger 2.0 YAML with per-entrypoint formats", async () => {
    const tasks = await addJson(openapi31);
    expect(tasks.snapshot.entrypoints[0]).toMatchObject({ format: "openapi", version: "3.1" });
    expect(tasks.snapshot.files[0]?.syntax).toBe("json");
    const pets = await addJson(swagger);
    expect(pets.snapshot.entrypoints[0]).toMatchObject({ format: "swagger", version: "2.0" });
  });

  it("re-importing unchanged content is idempotent: same id, no second slot", async () => {
    const first = await addJson(payments);
    expect(first.created).toBe(true);
    const second = await addJson(payments);
    expect(second.created).toBe(false);
    expect(second.snapshot.snapshotId).toBe(first.snapshot.snapshotId);
    expect(second.snapshot.sourceHash).toBe(first.snapshot.sourceHash);
  });

  it("imports explicit multiple entrypoints as one snapshot", async () => {
    const dir = join(root, "specs");
    mkdirSync(dir, { recursive: true });
    cpSync(payments, join(dir, "openapi.yaml"));
    cpSync(swagger, join(dir, "petstore.yaml"));
    const { snapshot } = await addJson(join(dir, "openapi.yaml"));
    expect(snapshot.files).toHaveLength(1);
    const both = await source(
      "add",
      join(dir, "openapi.yaml"),
      join(dir, "petstore.yaml"),
      "--json",
    );
    expect(both.code).toBe(0);
    const parsed = JSON.parse(both.io.stdout.join("\n")) as { snapshot: SourceSnapshot };
    // A mixed import keeps each entrypoint's own format — origin is not format.
    expect(parsed.snapshot.entrypoints.map((e) => e.format).sort()).toEqual(["openapi", "swagger"]);
  });

  it("imports a directory of specs as one snapshot with multiple files", async () => {
    const dir = join(root, "specs");
    mkdirSync(join(dir, "nested"), { recursive: true });
    cpSync(payments, join(dir, "openapi.yaml"));
    cpSync(swagger, join(dir, "nested", "petstore.yaml"));
    const { snapshot } = await addJson(dir, "--name", "combined");
    expect(snapshot.name).toBe("combined");
    expect(snapshot.files.map((f) => f.path)).toEqual(["nested/petstore.yaml", "openapi.yaml"]);
    expect(
      readFileSync(
        join(root, ".anvil/sources", snapshot.snapshotId, "raw/nested/petstore.yaml"),
      ).equals(readFileSync(swagger)),
    ).toBe(true);
  });

  it("locks a broken spec as an INVALID snapshot and exits non-zero", async () => {
    const broken = join(root, "broken.yaml");
    writeFileSync(broken, "openapi: [3.0.0\n  nope: {", "utf8");
    const { code, io } = await source("add", broken);
    expect(code).toBe(1);
    expect(io.text()).toContain("source/unparseable");
    // The capture still exists — diagnostics live inside the snapshot.
    const listed = await source("list", "--json");
    const listing = JSON.parse(listed.io.stdout.join("\n")) as {
      snapshots: SourceSnapshot[];
    };
    expect(listing.snapshots).toHaveLength(1);
    expect(listing.snapshots[0]?.status).toBe("invalid");
  });

  it("locks unclassifiable input as an UNCLASSIFIED snapshot and exits non-zero", async () => {
    const dir = join(root, "configs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), '{"a": 1}', "utf8");
    const { code, io } = await source("add", dir, "--json");
    expect(code).toBe(1);
    const { snapshot } = JSON.parse(io.stdout.join("\n")) as { snapshot: SourceSnapshot };
    expect(snapshot.status).toBe("unclassified");
  });

  it("writes nothing when nothing was readable", async () => {
    const { code, io } = await source("add", join(root, "ghost.yaml"));
    expect(code).toBe(1);
    expect(io.text()).toContain("source/not_found");
    const listed = await source("list", "--json");
    expect(JSON.parse(listed.io.stdout.join("\n"))).toEqual({ snapshots: [], corrupt: [] });
  });

  it("rejects an unknown --origin", async () => {
    const { code, io } = await source("add", payments, "--origin", "not_a_gateway");
    expect(code).toBe(1);
    expect(io.text()).toContain("source/unknown_origin");
  });

  it("records a declared gateway origin independently of the detected format", async () => {
    const { snapshot } = await addJson(payments, "--origin", "apigee", "--organization", "acme");
    expect(snapshot.origin.kind).toBe("apigee");
    expect(snapshot.entrypoints[0]?.format).toBe("openapi");
    expect(snapshot.metadata.organization).toBe("acme");
  });
});

describe("anvil source list / show", () => {
  it("lists locked snapshots and shows one in detail", async () => {
    const { snapshot } = await addJson(payments, "--name", "payments");
    const list = await source("list");
    expect(list.code).toBe(0);
    expect(list.io.text()).toContain(snapshot.snapshotId);
    expect(list.io.text()).toContain("payments");
    const show = await source("show", snapshot.snapshotId);
    expect(show.code).toBe(0);
    expect(show.io.text()).toContain("openapi 3.0 (yaml)");
    expect(show.io.text()).toContain("sourceHash: sha256:");
  });

  it("reports a corrupt stored snapshot instead of skipping it", async () => {
    await addJson(payments);
    const corrupt = join(root, ".anvil", "sources", "src-corrupt");
    mkdirSync(corrupt, { recursive: true });
    writeFileSync(join(corrupt, "source.json"), "{nope", "utf8");
    const { code, io } = await source("list");
    expect(code).toBe(0);
    expect(io.text()).toContain("CORRUPT");
    expect(io.text()).toContain("src-corrupt");
  });

  it("show of an unknown id exits non-zero", async () => {
    const { code, io } = await source("show", "src-ghost");
    expect(code).toBe(1);
    expect(io.text()).toContain("source/not_found");
  });
});

describe("anvil source validate", () => {
  it("confirms an intact snapshot", async () => {
    const { snapshot } = await addJson(payments);
    const { code, io } = await source("validate", snapshot.snapshotId);
    expect(code).toBe(0);
    expect(io.text()).toContain("intact");
  });

  it("detects a tampered raw file", async () => {
    const { snapshot } = await addJson(payments);
    const raw = join(root, ".anvil/sources", snapshot.snapshotId, "raw/openapi.yaml");
    writeFileSync(raw, `${readFileSync(raw, "utf8")}\n# tampered\n`, "utf8");
    const { code, io } = await source("validate", snapshot.snapshotId);
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
