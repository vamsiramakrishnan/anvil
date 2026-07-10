import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeSourceHash,
  createSnapshot,
  parseSourceSnapshot,
  type SnapshotFileInput,
  verifySnapshot,
} from "./snapshot.js";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../examples/${rel}`, import.meta.url)), "utf8");

const openapi30Yaml = read("payments/openapi.yaml");
const openapi31Json = read("fixtures/tasks-openapi31.json");
const swagger20Yaml = read("fixtures/petstore-swagger2.yaml");

// Deterministic clock: importedAt is provenance metadata, never hash input.
const clock = (iso: string) => () => new Date(iso);

describe("format detection", () => {
  it("detects OpenAPI 3.0 YAML", () => {
    const { snapshot, diagnostics } = createSnapshot({
      files: [{ path: "openapi.yaml", content: openapi30Yaml }],
      sourceUri: "examples/payments/openapi.yaml",
      now: clock("2026-07-10T00:00:00Z"),
    });
    expect(diagnostics.filter((d) => d.level === "error")).toEqual([]);
    expect(snapshot?.kind).toBe("openapi");
    expect(snapshot?.files[0]?.syntax).toBe("yaml");
    expect(snapshot?.files[0]?.detected).toEqual({ kind: "openapi", version: "3.0" });
  });

  it("detects OpenAPI 3.1 JSON", () => {
    const { snapshot } = createSnapshot({
      files: [{ path: "tasks.json", content: openapi31Json }],
      sourceUri: "examples/fixtures/tasks-openapi31.json",
      now: clock("2026-07-10T00:00:00Z"),
    });
    expect(snapshot?.kind).toBe("openapi");
    expect(snapshot?.files[0]?.syntax).toBe("json");
    expect(snapshot?.files[0]?.detected).toEqual({ kind: "openapi", version: "3.1" });
  });

  it("detects Swagger 2.0 YAML", () => {
    const { snapshot } = createSnapshot({
      files: [{ path: "petstore.yaml", content: swagger20Yaml }],
      sourceUri: "examples/fixtures/petstore-swagger2.yaml",
      now: clock("2026-07-10T00:00:00Z"),
    });
    expect(snapshot?.kind).toBe("swagger");
    expect(snapshot?.files[0]?.syntax).toBe("yaml");
    expect(snapshot?.files[0]?.detected).toEqual({ kind: "swagger", version: "2.0" });
  });

  it("accepts a declared gateway kind while detection stays per-file", () => {
    const { snapshot } = createSnapshot({
      files: [{ path: "openapi.yaml", content: openapi30Yaml }],
      sourceUri: "export/",
      kind: "apigee",
      metadata: { organization: "acme", environment: "prod" },
      now: clock("2026-07-10T00:00:00Z"),
    });
    expect(snapshot?.kind).toBe("apigee");
    expect(snapshot?.files[0]?.detected?.kind).toBe("openapi");
    expect(snapshot?.metadata.organization).toBe("acme");
  });
});

describe("broken input → structured diagnostics", () => {
  it("reports unparseable YAML instead of throwing", () => {
    const { snapshot, diagnostics } = createSnapshot({
      files: [{ path: "broken.yaml", content: "openapi: [3.0.0\n  bad: {indent" }],
      sourceUri: "broken.yaml",
    });
    expect(snapshot).toBeUndefined();
    expect(diagnostics).toEqual([
      expect.objectContaining({ level: "error", code: "source/unparseable", path: "broken.yaml" }),
    ]);
  });

  it("reports unparseable JSON instead of throwing", () => {
    const { snapshot, diagnostics } = createSnapshot({
      files: [{ path: "broken.json", content: '{"openapi": "3.1.0",' }],
      sourceUri: "broken.json",
    });
    expect(snapshot).toBeUndefined();
    expect(diagnostics[0]?.code).toBe("source/unparseable");
  });

  it("reports an unknown format when nothing declares openapi/swagger", () => {
    const { snapshot, diagnostics } = createSnapshot({
      files: [{ path: "notes.yaml", content: "just: some\nrandom: yaml\n" }],
      sourceUri: "notes.yaml",
    });
    expect(snapshot).toBeUndefined();
    expect(diagnostics.some((d) => d.code === "source/unknown_format")).toBe(true);
  });

  it("reports an empty import", () => {
    const { snapshot, diagnostics } = createSnapshot({ files: [], sourceUri: "empty/" });
    expect(snapshot).toBeUndefined();
    expect(diagnostics[0]?.code).toBe("source/empty");
  });
});

describe("deterministic hashing", () => {
  const files: SnapshotFileInput[] = [
    { path: "a/openapi.yaml", content: openapi30Yaml },
    { path: "b/petstore.yaml", content: swagger20Yaml },
  ];

  it("re-importing unchanged content yields the same hash and id, whatever the clock says", () => {
    const first = createSnapshot({
      files,
      sourceUri: "specs/",
      now: clock("2026-01-01T00:00:00Z"),
    });
    const second = createSnapshot({
      files: [...files].reverse(), // read order must not matter either
      sourceUri: "specs/",
      now: clock("2026-07-10T12:34:56Z"),
    });
    expect(first.snapshot?.sourceHash).toBe(second.snapshot?.sourceHash);
    expect(first.snapshot?.id).toBe(second.snapshot?.id);
    expect(first.snapshot?.importedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(second.snapshot?.importedAt).toBe("2026-07-10T12:34:56.000Z");
  });

  it("changed content or a moved file changes the hash", () => {
    const base = computeSourceHash(files);
    expect(
      computeSourceHash([
        { ...files[0], content: `${openapi30Yaml}#\n` } as SnapshotFileInput,
        files[1] as SnapshotFileInput,
      ]),
    ).not.toBe(base);
    expect(
      computeSourceHash([
        { ...files[0], path: "moved.yaml" } as SnapshotFileInput,
        files[1] as SnapshotFileInput,
      ]),
    ).not.toBe(base);
  });
});

describe("directory-shaped imports", () => {
  it("captures multiple specs plus supporting files in one snapshot", () => {
    const { snapshot, diagnostics } = createSnapshot({
      files: [
        { path: "payments/openapi.yaml", content: openapi30Yaml },
        { path: "petstore/swagger.yaml", content: swagger20Yaml },
        { path: "shared/components.yaml", content: "components:\n  schemas: {}\n" },
      ],
      sourceUri: "specs/",
      now: clock("2026-07-10T00:00:00Z"),
    });
    expect(snapshot?.files.map((f) => f.path)).toEqual([
      "payments/openapi.yaml",
      "petstore/swagger.yaml",
      "shared/components.yaml",
    ]);
    // Mixed directory: the snapshot's kind is the most modern family present.
    expect(snapshot?.kind).toBe("openapi");
    expect(snapshot?.files[2]?.detected).toBeUndefined();
    expect(diagnostics).toEqual([
      expect.objectContaining({ level: "info", code: "source/no_declared_format" }),
    ]);
  });
});

describe("verifySnapshot", () => {
  const files: SnapshotFileInput[] = [
    { path: "openapi.yaml", content: openapi30Yaml },
    { path: "petstore.yaml", content: swagger20Yaml },
  ];
  const snapshot = createSnapshot({
    files,
    sourceUri: "specs/",
    now: clock("2026-07-10T00:00:00Z"),
  }).snapshot;
  if (!snapshot) throw new Error("fixture snapshot failed");

  it("passes on the unchanged file set", () => {
    expect(verifySnapshot(snapshot, files)).toEqual({ ok: true, diagnostics: [] });
  });

  it("detects a tampered file", () => {
    const tampered = [
      files[0] as SnapshotFileInput,
      { path: "petstore.yaml", content: "swagger: '2.0'\n# tampered\n" },
    ];
    const result = verifySnapshot(snapshot, tampered);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "source/file_changed", path: "petstore.yaml" }),
    ]);
  });

  it("detects missing and added files", () => {
    const result = verifySnapshot(snapshot, [
      files[0] as SnapshotFileInput,
      { path: "extra.yaml", content: "x: 1\n" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code).sort()).toEqual([
      "source/file_added",
      "source/file_missing",
    ]);
  });
});

describe("parseSourceSnapshot", () => {
  it("round-trips a stored snapshot", () => {
    const snapshot = createSnapshot({
      files: [{ path: "openapi.yaml", content: openapi30Yaml }],
      sourceUri: "specs/",
      now: clock("2026-07-10T00:00:00Z"),
    }).snapshot;
    const parsed = parseSourceSnapshot(JSON.stringify(snapshot));
    expect(parsed.snapshot).toEqual(snapshot);
  });

  it("rejects malformed JSON and off-schema records as diagnostics", () => {
    expect(parseSourceSnapshot("{nope").diagnostics[0]?.code).toBe("source/unparseable");
    expect(parseSourceSnapshot('{"schemaVersion": 2}').diagnostics[0]?.code).toBe(
      "source/invalid_snapshot",
    );
  });
});
