import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquire, inspectBytes, sha256 } from "./acquire.mjs";
import { coverage, inventory } from "./checks.mjs";
import { run } from "./process.mjs";

const directories: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "anvil-enterprise-"));
  directories.push(root);
  const sourceDir = join(root, "exports");
  mkdirSync(sourceDir);
  return { sourceDir, cache: join(root, "cache"), reportDir: root, offline: true, refresh: true };
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const system = { id: "sample", extension: "json", access: "public", url: "https://example.test/spec.json" };
const bytes = Buffer.from('{"openapi":"3.0.3","paths":{"/items":{"get":{}}}}');

describe("enterprise source acquisition", () => {
  it("preserves exact vendor bytes and rejects cache tampering", async () => {
    const options = setup();
    writeFileSync(join(options.sourceDir, "sample.json"), bytes);
    const lock = {};
    const first = await acquire(system, options, lock);
    expect(first.status).toBe("acquired");
    expect(readFileSync(first.file)).toEqual(bytes);
    expect(first.sha256).toBe(sha256(bytes));
    writeFileSync(first.file, Buffer.concat([bytes, Buffer.from(" ")]));
    const replay = await acquire(system, { ...options, sourceDir: undefined, refresh: false }, lock);
    expect(replay.status).toBe("source-drift");
  });

  it("cannot refresh arbitrary bytes into a pinned publisher identity", async () => {
    const options = setup();
    writeFileSync(join(options.sourceDir, "sample.json"), bytes);
    const expected = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    expect((await acquire({ ...system, sourceBlob: expected }, options, {})).status).toBe("acquired");
    writeFileSync(join(options.sourceDir, "sample.json"), Buffer.concat([bytes, Buffer.from("\n")]));
    expect((await acquire({ ...system, sourceBlob: expected }, options, {})).status).toBe("source-drift");
  });

  it("distinguishes a required tenant export from a failed public acquisition", async () => {
    const options = setup();
    expect((await acquire({ ...system, access: "export-required", instructions: "Export tenant metadata." }, options, {})).status).toBe("needs-export");
    expect((await acquire(system, options, {})).status).toBe("unavailable");
  });

  it("rejects login pages and invalid UTF-8 instead of treating them as specs", () => {
    const options = setup();
    const path = join(options.sourceDir, "sample.json");
    writeFileSync(path, "<!DOCTYPE html><html>Sign in</html>");
    expect(() => inspectBytes(path)).toThrow(/HTML/);
    writeFileSync(path, Buffer.from([0xff, 0xfe]));
    expect(() => inspectBytes(path)).toThrow();
  });
});

describe("enterprise conversion oracles", () => {
  it("catches silent method loss even when the emitted bundle is valid", () => {
    const source = inventory(JSON.stringify({ discoveryVersion: "v1", methods: { root: { id: "root.get" } }, resources: { places: { methods: { get: { id: "places.get" }, media: { id: "photos.getMedia" } } } } }), "discovery");
    expect(source.entries).toEqual(["root.get", "places.get", "photos.getMedia"]);
    expect(coverage(source, { operations: [{ sourceRef: { operationId: "photos.getMedia" } }] }).ok).toBe(false);
  });

  it("checks the original HTTP coordinates, including duplicate/drop accounting", () => {
    const source = inventory(bytes.toString(), "openapi");
    expect(coverage(source, { operations: [{ sourceRef: { method: "get", path: "/other" } }] }).ok).toBe(false);
    expect(coverage(source, { operations: [{ sourceRef: { method: "get", path: "/items" } }] }).ok).toBe(true);
  });

  it("bounds hanging conversions and records a timeout as a failure", async () => {
    const result = await run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });
});
