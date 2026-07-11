import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemSourceImporter } from "./import.js";
import { SourceService } from "./service.js";
import { FileSystemSourceSnapshotStore } from "./store.js";

let tmp: string;
let sourcesRoot: string;
let store: FileSystemSourceSnapshotStore;
let service: SourceService;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "anvil-store-"));
  sourcesRoot = join(tmp, ".anvil", "sources");
  store = new FileSystemSourceSnapshotStore(sourcesRoot);
  service = new SourceService({
    importer: new FilesystemSourceImporter(),
    store,
    clock: () => new Date("2026-07-10T00:00:00Z"),
  });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function write(rel: string, content: string | Uint8Array): string {
  const full = join(tmp, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
}

const OPENAPI = 'openapi: "3.0.3"\ninfo: { title: T, version: "1" }\npaths: {}\n';

describe("atomic immutable create", () => {
  it("stores raw/ byte-identically — CRLF and BOM survive the round trip", async () => {
    const original = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]), // UTF-8 BOM
      Buffer.from('openapi: "3.0.3"\r\ninfo: { title: T, version: "1" }\r\npaths: {}\r\n', "utf8"),
    ]);
    const spec = write("openapi.yaml", original);
    const { snapshot, dir } = await service.add([spec]);
    expect(snapshot?.status).toBe("valid");
    const stored = readFileSync(join(dir as string, "raw", "openapi.yaml"));
    expect(stored.equals(original)).toBe(true);
  });

  it("re-creating the same content is an idempotent success, not a rewrite", async () => {
    const spec = write("openapi.yaml", OPENAPI);
    const first = await service.add([spec]);
    expect(first.created).toBe(true);
    const second = await service.add([spec]);
    expect(second.created).toBe(false);
    expect(second.snapshot?.snapshotId).toBe(first.snapshot?.snapshotId);
    expect(readdirSync(sourcesRoot)).toHaveLength(1);
  });

  it("changed content lands in a new slot; both snapshots coexist", async () => {
    const spec = write("openapi.yaml", OPENAPI);
    const first = await service.add([spec]);
    write("openapi.yaml", `${OPENAPI}# v2\n`);
    const second = await service.add([spec]);
    expect(second.snapshot?.snapshotId).not.toBe(first.snapshot?.snapshotId);
    expect(readdirSync(sourcesRoot).sort()).toEqual(
      [first.snapshot?.snapshotId, second.snapshot?.snapshotId].sort(),
    );
  });

  it("a human name never overwrites another snapshot", async () => {
    const spec = write("openapi.yaml", OPENAPI);
    const first = await service.add([spec], { name: "payments" });
    write("openapi.yaml", `${OPENAPI}# changed\n`);
    const second = await service.add([spec], { name: "payments" });
    // Same name, different content → two snapshots; the name is only a label.
    expect(second.snapshot?.snapshotId).not.toBe(first.snapshot?.snapshotId);
    expect(readdirSync(sourcesRoot)).toHaveLength(2);
    const verified = await store.verify(first.snapshot?.snapshotId as string);
    expect(verified.ok).toBe(true);
  });

  it("refuses a slot collision with different content instead of overwriting", async () => {
    const spec = write("openapi.yaml", OPENAPI);
    const { snapshot } = await service.add([spec]);
    if (!snapshot) throw new Error("fixture snapshot failed");
    const forged = { ...snapshot, sourceHash: "sha256:0000" };
    const result = await store.create(forged, [
      { path: "openapi.yaml", bytes: Buffer.from(OPENAPI) },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.diagnostics[0]?.code).toBe("source/id_collision");
  });

  it("a failed create leaves no final directory and no temp litter", async () => {
    const spec = write("openapi.yaml", OPENAPI);
    const { snapshot } = await service.add([spec]);
    if (!snapshot) throw new Error("fixture snapshot failed");
    rmSync(sourcesRoot, { recursive: true, force: true });
    // A recorded file with no bytes fails mid-write, before source.json/rename.
    const result = await store.create(snapshot, []);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.diagnostics[0]?.code).toBe("source/missing_content");
    expect(existsSync(join(sourcesRoot, snapshot.snapshotId))).toBe(false);
    expect(readdirSync(sourcesRoot)).toEqual([]); // temp sibling was cleaned up
  });
});

describe("list", () => {
  it("reports corrupt stored snapshots explicitly instead of skipping them", async () => {
    const spec = write("openapi.yaml", OPENAPI);
    const { snapshot } = await service.add([spec]);
    mkdirSync(join(sourcesRoot, "src-corrupt"), { recursive: true });
    writeFileSync(join(sourcesRoot, "src-corrupt", "source.json"), "{nope", "utf8");
    mkdirSync(join(sourcesRoot, "src-empty"), { recursive: true });
    const listing = await service.list();
    expect(listing.snapshots.map((s) => s.snapshotId)).toEqual([snapshot?.snapshotId]);
    expect(listing.corrupt.map((c) => c.snapshotId)).toEqual(["src-corrupt", "src-empty"]);
    expect(listing.corrupt[0]?.diagnostics[0]?.code).toBe("source/unparseable");
    expect(listing.corrupt[1]?.diagnostics[0]?.code).toBe("source/invalid_snapshot");
  });
});

describe("verify", () => {
  it("passes on an intact snapshot", async () => {
    const spec = write("openapi.yaml", OPENAPI);
    const { snapshot } = await service.add([spec]);
    expect(await service.validate(snapshot?.snapshotId as string)).toEqual({
      ok: true,
      diagnostics: [],
    });
  });

  it("catches changed, added, and missing raw files", async () => {
    const spec = write("openapi.yaml", OPENAPI);
    const { snapshot, dir } = await service.add([spec]);
    const raw = join(dir as string, "raw");
    writeFileSync(join(raw, "openapi.yaml"), `${OPENAPI}# tampered\n`, "utf8");
    writeFileSync(join(raw, "extra.yaml"), "x: 1\n", "utf8");
    const result = await service.validate(snapshot?.snapshotId as string);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code).sort()).toEqual([
      "source/file_added",
      "source/file_changed",
    ]);
  });

  it("catches a tampered source.json even when every file matches its record", async () => {
    const spec = write("openapi.yaml", OPENAPI);
    const { snapshot, dir } = await service.add([spec]);
    if (!snapshot || !dir) throw new Error("fixture snapshot failed");
    const doctored = { ...snapshot, sourceHash: `sha256:${"0".repeat(64)}` };
    writeFileSync(join(dir, "source.json"), JSON.stringify(doctored, null, 2), "utf8");
    const result = await service.validate(snapshot.snapshotId);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["source/hash_mismatch"]);
  });
});

describe("service capture semantics", () => {
  it("locks an invalid snapshot too: diagnostics live inside it", async () => {
    const spec = write("broken.yaml", "openapi: [3.0.0\n  nope: {");
    const { snapshot, dir } = await service.add([spec]);
    expect(snapshot?.status).toBe("invalid");
    expect(dir).toBeDefined();
    const stored = JSON.parse(readFileSync(join(dir as string, "source.json"), "utf8"));
    expect(stored.status).toBe("invalid");
    expect(stored.diagnostics).toContainEqual(
      expect.objectContaining({ code: "source/unparseable" }),
    );
  });

  it("show round-trips what add locked", async () => {
    const spec = write("openapi.yaml", OPENAPI);
    const { snapshot } = await service.add([spec], { name: "payments" });
    const shown = await service.show(snapshot?.snapshotId as string);
    expect(shown.snapshot).toEqual(snapshot);
  });

  it("show of an unknown id fails as data", async () => {
    const shown = await service.show("src-none");
    expect(shown.snapshot).toBeUndefined();
    expect(shown.diagnostics[0]?.code).toBe("source/not_found");
  });
});
