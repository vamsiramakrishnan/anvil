import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeSourceHash } from "./hash.js";
import { FilesystemSourceImporter } from "./import.js";
import { invalidPathReason, parseSourceSnapshot } from "./model.js";
import { snapshotFromImport } from "./service.js";

const importer = new FilesystemSourceImporter();
// Deterministic clock: importedAt is provenance metadata, never hash input.
const clock = () => new Date("2026-07-10T00:00:00Z");

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "anvil-import-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** Write a file under the temp workspace, creating parents. */
function write(rel: string, content: string | Uint8Array): string {
  const full = join(tmp, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
}

const OPENAPI_HEAD = 'openapi: "3.0.3"\ninfo: { title: T, version: "1" }\n';
const SWAGGER_HEAD = 'swagger: "2.0"\ninfo: { title: S, version: "1" }\n';

/** Import + freeze in one step, the way the service composes them. */
async function snap(...targets: string[]) {
  const imported = await importer.import(targets);
  const snapshot = snapshotFromImport(imported, {
    originUri: targets[0] ?? "?",
    clock,
  });
  return { imported, snapshot };
}

describe("explicit entrypoints", () => {
  it("captures the entrypoint and every reachable local $ref, transitively", async () => {
    const spec = write(
      "api/openapi.yaml",
      `${OPENAPI_HEAD}paths:\n  /pets:\n    get:\n      responses:\n        "200":\n          content:\n            application/json:\n              schema:\n                $ref: "./schemas/pet.yaml#/Pet"\n`,
    );
    write(
      "api/schemas/pet.yaml",
      'Pet:\n  type: object\n  properties:\n    err:\n      $ref: "../common/error.yaml"\n',
    );
    write("api/common/error.yaml", "type: object\n");
    const { snapshot } = await snap(spec);
    expect(snapshot?.status).toBe("valid");
    expect(snapshot?.entrypoints).toEqual([
      { path: "openapi.yaml", format: "openapi", version: "3.0" },
    ]);
    expect(snapshot?.files.map((f) => [f.path, f.role])).toEqual([
      ["common/error.yaml", "reference"],
      ["openapi.yaml", "entrypoint"],
      ["schemas/pet.yaml", "reference"],
    ]);
  });

  it("deduplicates a schema shared by two entrypoints", async () => {
    const a = write(
      "a.yaml",
      `${OPENAPI_HEAD}paths:\n  /a:\n    get:\n      responses:\n        "200":\n          content:\n            application/json:\n              schema:\n                $ref: "shared.yaml"\n`,
    );
    const b = write(
      "b.yaml",
      `${SWAGGER_HEAD}paths:\n  /b:\n    get:\n      responses:\n        "200":\n          schema:\n            $ref: "shared.yaml"\n`,
    );
    write("shared.yaml", "type: object\n");
    const { snapshot } = await snap(a, b);
    expect(snapshot?.files.map((f) => f.path)).toEqual(["a.yaml", "b.yaml", "shared.yaml"]);
    // A mixed import keeps each entrypoint's own format and version.
    expect(snapshot?.entrypoints).toEqual([
      { path: "a.yaml", format: "openapi", version: "3.0" },
      { path: "b.yaml", format: "swagger", version: "2.0" },
    ]);
  });

  it("rejects a reference escaping the import root", async () => {
    write("outside.yaml", "type: object\n");
    const spec = write(
      "api/openapi.yaml",
      `${OPENAPI_HEAD}components:\n  schemas:\n    X:\n      $ref: "../outside.yaml"\n`,
    );
    const { snapshot } = await snap(spec);
    expect(snapshot?.status).toBe("invalid");
    expect(snapshot?.diagnostics).toContainEqual(
      expect.objectContaining({ level: "error", code: "source/path_escape" }),
    );
    expect(snapshot?.files.map((f) => f.path)).toEqual(["openapi.yaml"]);
  });

  it("records a remote ref as external without fetching it", async () => {
    const spec = write(
      "openapi.yaml",
      `${OPENAPI_HEAD}components:\n  schemas:\n    X:\n      $ref: "https://example.com/x.yaml#/X"\n`,
    );
    const { snapshot } = await snap(spec);
    expect(snapshot?.status).toBe("valid");
    expect(snapshot?.files).toHaveLength(1);
    expect(snapshot?.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "info",
        code: "source/external_ref",
        path: "openapi.yaml",
      }),
    );
  });

  it("captures malformed YAML as an invalid snapshot with a line/column diagnostic", async () => {
    const spec = write("broken.yaml", "openapi: [3.0.0\n  bad: {indent");
    const { snapshot } = await snap(spec);
    expect(snapshot?.status).toBe("invalid");
    const diag = snapshot?.diagnostics.find((d) => d.code === "source/unparseable");
    expect(diag?.level).toBe("error");
    expect(diag?.path).toBe("broken.yaml");
    expect(diag?.line).toBeGreaterThanOrEqual(1);
    expect(diag?.column).toBeGreaterThanOrEqual(1);
    // The bytes are still captured — provenance never depends on a clean parse.
    expect(snapshot?.files.map((f) => f.path)).toEqual(["broken.yaml"]);
  });

  it("captures invalid UTF-8 with a structured diagnostic and an invalid status", async () => {
    const spec = write("garbled.yaml", Buffer.from([0xff, 0xfe, 0x00, 0x64]));
    const { snapshot } = await snap(spec);
    expect(snapshot?.status).toBe("invalid");
    expect(snapshot?.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        code: "source/invalid_utf8",
        path: "garbled.yaml",
      }),
    );
    expect(snapshot?.files[0]).toMatchObject({
      path: "garbled.yaml",
      bytes: 4,
      role: "supporting",
    });
    expect(snapshot?.files[0]?.syntax).toBeUndefined();
  });

  it("produces no snapshot only when nothing could be read", async () => {
    const { snapshot, imported } = await snap(join(tmp, "ghost.yaml"));
    expect(snapshot).toBeUndefined();
    expect(imported.diagnostics).toEqual([
      expect.objectContaining({ level: "error", code: "source/not_found" }),
    ]);
  });

  it("flags a missing local ref without dropping the capture", async () => {
    const spec = write(
      "openapi.yaml",
      `${OPENAPI_HEAD}components:\n  schemas:\n    X:\n      $ref: "./gone.yaml"\n`,
    );
    const { snapshot } = await snap(spec);
    expect(snapshot?.status).toBe("valid");
    expect(snapshot?.diagnostics).toContainEqual(
      expect.objectContaining({ level: "warning", code: "source/ref_missing" }),
    );
  });
});

describe("directory import", () => {
  it("keeps entrypoints and their ref graphs; excludes unrelated YAML/JSON", async () => {
    write(
      "specs/openapi.yaml",
      `${OPENAPI_HEAD}components:\n  schemas:\n    Pet:\n      $ref: "components/schemas.yaml#/Pet"\n`,
    );
    write("specs/components/schemas.yaml", "Pet:\n  type: object\n");
    write("specs/config.json", '{"just": "settings"}');
    write("specs/notes.yaml", "todo: write docs\n");
    write("specs/.hidden/secret.yaml", OPENAPI_HEAD);
    write("specs/generated/out.yaml", OPENAPI_HEAD);
    write("specs/.anvil/sources/x/source.json", "{}");
    const { snapshot } = await snap(join(tmp, "specs"));
    expect(snapshot?.status).toBe("valid");
    expect(snapshot?.files.map((f) => [f.path, f.role])).toEqual([
      ["components/schemas.yaml", "reference"],
      ["openapi.yaml", "entrypoint"],
    ]);
    // Probed-but-unrelated files are excluded visibly; hidden/generated paths
    // are never probed at all.
    const unrelated = snapshot?.diagnostics
      .filter((d) => d.code === "source/unrelated_file")
      .map((d) => d.path);
    expect(unrelated).toEqual(["config.json", "notes.yaml"]);
  });

  it("keeps per-entrypoint formats in a mixed swagger + openapi directory", async () => {
    write("mixed/payments/openapi.yaml", OPENAPI_HEAD);
    write("mixed/legacy/petstore.yaml", SWAGGER_HEAD);
    const { snapshot } = await snap(join(tmp, "mixed"));
    expect(snapshot?.status).toBe("valid");
    expect(snapshot?.entrypoints).toEqual([
      { path: "legacy/petstore.yaml", format: "swagger", version: "2.0" },
      { path: "payments/openapi.yaml", format: "openapi", version: "3.0" },
    ]);
  });

  it("captures a directory of unknown JSON as an unclassified snapshot", async () => {
    write("data/config.json", '{"a": 1}');
    write("data/more.json", '{"b": 2}');
    const { snapshot } = await snap(join(tmp, "data"));
    expect(snapshot?.status).toBe("unclassified");
    expect(snapshot?.entrypoints).toEqual([]);
    expect(snapshot?.files.map((f) => [f.path, f.role, f.syntax])).toEqual([
      ["config.json", "supporting", "json"],
      ["more.json", "supporting", "json"],
    ]);
    expect(snapshot?.diagnostics).toContainEqual(
      expect.objectContaining({ level: "warning", code: "source/unclassified" }),
    );
  });

  it("never follows a symlink outside the import root", async () => {
    write("elsewhere/leak.yaml", OPENAPI_HEAD);
    write("tree/openapi.yaml", OPENAPI_HEAD);
    symlinkSync(join(tmp, "elsewhere/leak.yaml"), join(tmp, "tree/leak.yaml"));
    const { snapshot } = await snap(join(tmp, "tree"));
    expect(snapshot?.files.map((f) => f.path)).toEqual(["openapi.yaml"]);
    expect(snapshot?.diagnostics).toContainEqual(
      expect.objectContaining({ level: "warning", code: "source/path_escape", path: "leak.yaml" }),
    );
  });
});

describe("content identity", () => {
  it("hashes verbatim bytes: a newline flavor change is a different source", () => {
    const lf = { path: "a.yaml", bytes: Buffer.from("openapi: 3.0.3\n", "utf8") };
    const crlf = { path: "a.yaml", bytes: Buffer.from("openapi: 3.0.3\r\n", "utf8") };
    expect(computeSourceHash([lf])).not.toBe(computeSourceHash([crlf]));
  });

  it("re-importing unchanged content yields the same id, whatever the clock says", async () => {
    const spec = write("openapi.yaml", OPENAPI_HEAD);
    const first = await snap(spec);
    const laterClock = () => new Date("2026-07-11T12:34:56Z");
    const second = snapshotFromImport(await importer.import([spec]), {
      originUri: spec,
      clock: laterClock,
    });
    expect(second?.snapshotId).toBe(first.snapshot?.snapshotId);
    expect(second?.sourceHash).toBe(first.snapshot?.sourceHash);
    expect(second?.importedAt).not.toBe(first.snapshot?.importedAt);
  });

  it("changed content produces a new id", async () => {
    const spec = write("openapi.yaml", OPENAPI_HEAD);
    const first = await snap(spec);
    write("openapi.yaml", `${OPENAPI_HEAD}# comment\n`);
    const second = await snap(spec);
    expect(second.snapshot?.snapshotId).not.toBe(first.snapshot?.snapshotId);
  });

  it("a name labels a snapshot without touching its identity", async () => {
    const spec = write("openapi.yaml", OPENAPI_HEAD);
    const imported = await importer.import([spec]);
    const anonymous = snapshotFromImport(imported, { originUri: spec, clock });
    const named = snapshotFromImport(imported, { originUri: spec, clock, name: "payments" });
    expect(named?.name).toBe("payments");
    expect(named?.snapshotId).toBe(anonymous?.snapshotId);
    expect(named?.sourceHash).toBe(anonymous?.sourceHash);
  });
});

describe("snapshot paths", () => {
  it.each([
    ["", "empty"],
    ["a\0b.yaml", "NUL"],
    ["a\\b.yaml", "POSIX"],
    ["/etc/passwd", "relative"],
    ["C:/spec.yaml", "Windows drive"],
    ["../up.yaml", "'..'"],
    ["a//b.yaml", "empty or '.'"],
  ])("rejects %j", (path, fragment) => {
    expect(invalidPathReason(path)).toContain(fragment);
  });

  it("accepts clean relative posix paths", () => {
    expect(invalidPathReason("nested/openapi.yaml")).toBeUndefined();
  });

  it("a stored snapshot with a hostile path fails to parse", async () => {
    const spec = write("openapi.yaml", OPENAPI_HEAD);
    const { snapshot } = await snap(spec);
    const hostile = {
      ...snapshot,
      files: [{ ...snapshot?.files[0], path: "../../escape.yaml" }],
    };
    const parsed = parseSourceSnapshot(JSON.stringify(hostile));
    expect(parsed.snapshot).toBeUndefined();
    expect(parsed.diagnostics[0]?.code).toBe("source/invalid_snapshot");
  });
});
