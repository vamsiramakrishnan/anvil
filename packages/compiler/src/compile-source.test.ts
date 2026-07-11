import { describe, expect, it } from "vitest";
import { compile, compileSource } from "./compile.js";
import { type CompilerSource, compilerSourceFromSnapshot } from "./source/compiler-source.js";
import { computeSourceHash, deriveSnapshotId, type SourceInputFile } from "./source/hash.js";
import type { SourceSnapshot } from "./source/model.js";

const enc = (s: string) => new TextEncoder().encode(s);

const ENTRY = `openapi: 3.0.3
info: { title: Ledger, version: 1.0.0 }
paths:
  /entries:
    post:
      operationId: createEntry
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "./schemas/entry.yaml#/EntryCreate"
      responses:
        "201": { description: Created. }
`;

const SCHEMA = `EntryCreate:
  type: object
  required: [amount]
  properties:
    amount: { type: integer }
    memo: { type: string }
`;

/** A two-file CompilerSource whose entrypoint pulls a schema from a sibling. */
function multiFileSource(
  files: Record<string, string>,
  entrypoint = "openapi.yaml",
): CompilerSource {
  const inputs: SourceInputFile[] = Object.entries(files).map(([path, text]) => ({
    path,
    bytes: enc(text),
  }));
  const sourceHash = computeSourceHash(inputs);
  return {
    snapshotId: deriveSnapshotId(sourceHash),
    sourceHash,
    origin: { kind: "filesystem", uri: "./specs" },
    entrypoint: { path: entrypoint, format: "openapi", version: "3.0" },
    files: new Map(inputs.map((f) => [f.path, f.bytes])),
  };
}

describe("compileSource — the virtual filesystem is the compile input", () => {
  it("resolves a local $ref against the snapshot's other files", async () => {
    const source = multiFileSource({ "openapi.yaml": ENTRY, "schemas/entry.yaml": SCHEMA });
    const air = await compileSource(source, { serviceId: "ledger" });
    const create = air.operations.find((o) => o.canonicalName === "create_entry");
    expect(create).toBeDefined();
    // The requestBody schema came from schemas/entry.yaml, not the entrypoint.
    const props = create?.input.schema?.properties ?? {};
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["amount", "memo"]));
  });

  it("binds the AIR to the snapshot provenance", async () => {
    const source = multiFileSource({ "openapi.yaml": ENTRY, "schemas/entry.yaml": SCHEMA });
    const air = await compileSource(source, { serviceId: "ledger" });
    expect(air.service.source.snapshotId).toBe(source.snapshotId);
    expect(air.service.source.sourceHash).toBe(source.sourceHash);
    expect(air.service.source.origin).toEqual({ kind: "filesystem", uri: "./specs" });
    expect(air.service.source.entrypoint).toBe("openapi.yaml");
    expect(air.service.source.kind).toBe("openapi");
  });

  it("refuses a $ref that points outside the snapshot", async () => {
    // The schema file is simply not present in the virtual filesystem.
    const source = multiFileSource({ "openapi.yaml": ENTRY });
    await expect(compileSource(source, { serviceId: "ledger" })).rejects.toThrow(
      /not represented in the snapshot|resolve source references/,
    );
  });

  it("never reads host bytes: the files map alone determines the result", async () => {
    const good = multiFileSource({ "openapi.yaml": ENTRY, "schemas/entry.yaml": SCHEMA });
    const tightened = SCHEMA.replace("required: [amount]", "required: [amount, memo]");
    const changed = multiFileSource({ "openapi.yaml": ENTRY, "schemas/entry.yaml": tightened });
    const a = await compileSource(good, { serviceId: "ledger" });
    const b = await compileSource(changed, { serviceId: "ledger" });
    const req = (air: Awaited<ReturnType<typeof compileSource>>) =>
      air.operations.find((o) => o.canonicalName === "create_entry")?.input.schema?.required ?? [];
    // Different bytes in the map → different contract; same bytes → same contract.
    expect(req(a)).not.toEqual(req(b));
    expect(req(b)).toEqual(expect.arrayContaining(["memo"]));
  });
});

describe("compile({ spec }) — the ephemeral compatibility path", () => {
  it("still records deterministic content-derived provenance", async () => {
    const spec = `openapi: 3.0.3
info: { title: Ping, version: 1.0.0 }
paths:
  /ping: { get: { operationId: ping, responses: { "200": { description: ok } } } }
`;
    const air = await compile({ spec, sourceUri: "./ping.yaml" });
    expect(air.service.source.snapshotId).toMatch(/^src-/);
    expect(air.service.source.sourceHash).toMatch(/^sha256:/);
    expect(air.service.source.entrypoint).toBe("ping.yaml");
    // Recompiling identical text yields an identical snapshot identity.
    const again = await compile({ spec, sourceUri: "./ping.yaml" });
    expect(again.service.source.sourceHash).toBe(air.service.source.sourceHash);
  });
});

describe("compilerSourceFromSnapshot — entrypoint selection and status gating", () => {
  const files: SourceInputFile[] = [{ path: "openapi.yaml", bytes: enc(ENTRY) }];
  const base: SourceSnapshot = {
    schemaVersion: 1,
    snapshotId: "src-test",
    origin: { kind: "filesystem", uri: "./specs" },
    status: "valid",
    importedAt: "2026-07-11T00:00:00.000Z",
    sourceHash: computeSourceHash(files),
    entrypoints: [{ path: "openapi.yaml", format: "openapi", version: "3.0" }],
    files: [{ path: "openapi.yaml", sha256: "x", bytes: 1, syntax: "yaml", role: "entrypoint" }],
    diagnostics: [],
    metadata: {},
  };

  it("refuses to compile a non-valid snapshot", () => {
    const { source, diagnostics } = compilerSourceFromSnapshot(
      { ...base, status: "invalid" },
      files,
    );
    expect(source).toBeUndefined();
    expect(diagnostics[0]?.code).toBe("source/not_compilable");
  });

  it("requires --entrypoint when a snapshot has several", () => {
    const two: SourceSnapshot = {
      ...base,
      entrypoints: [
        { path: "a.yaml", format: "openapi", version: "3.0" },
        { path: "b.yaml", format: "openapi", version: "3.0" },
      ],
    };
    const { source, diagnostics } = compilerSourceFromSnapshot(two, files);
    expect(source).toBeUndefined();
    expect(diagnostics[0]?.code).toBe("source/ambiguous_entrypoint");
  });

  it("rejects an unknown --entrypoint", () => {
    const { diagnostics } = compilerSourceFromSnapshot(base, files, "ghost.yaml");
    expect(diagnostics[0]?.code).toBe("source/unknown_entrypoint");
  });
});
