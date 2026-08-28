import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { readArchive } from "@anvil/system-pack";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bufferIO } from "../io.js";
import { runPackBuild, runPackInstall, runPackVerify } from "./pack.js";

/**
 * The distribution seam, proven on a real compiled bundle. The properties that
 * matter are the trust ones: determinism (the same bundle packs to the same
 * bytes), tamper-evidence (one flipped byte refuses with the divergence
 * named), the certification gate (uncertified refuses unless the operator says
 * otherwise in words), and transactionality (a refused install leaves nothing
 * behind).
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../examples/${rel}`, import.meta.url)), "utf8");

let root: string;
let bundleDir: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "anvil-pack-"));
  const air = await compile({
    spec: read("payments/openapi.yaml"),
    manifest: read("payments/anvil.yaml"),
    serviceId: "payments",
  });
  bundleDir = join(root, "bundle");
  writeBundle(bundleDir, generateBundle(air));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("anvil pack build", () => {
  it("packs deterministically: the same bundle yields byte-identical output", () => {
    const a = join(root, "a.pack.json");
    const b = join(root, "b.pack.json");
    expect(runPackBuild(bundleDir, { out: a }, bufferIO())).toBe(0);
    expect(runPackBuild(bundleDir, { out: b }, bufferIO())).toBe(0);
    expect(readFileSync(a, "utf8")).toBe(readFileSync(b, "utf8"));
  });

  it("keeps derived records out of the pack, same boundary as the bundle hash", () => {
    writeFileSync(join(bundleDir, "selftest.report.json"), "{}", "utf8");
    const out = join(root, "with-report.pack.json");
    expect(runPackBuild(bundleDir, { out }, bufferIO())).toBe(0);
    const { contents } = readArchive(readFileSync(out));
    expect(contents.has("selftest.report.json")).toBe(false);
    expect(contents.has("air.json")).toBe(true);
    rmSync(join(bundleDir, "selftest.report.json"));
  });
});

describe("anvil pack verify", () => {
  it("verifies an untouched pack and names the divergence in a tampered one", () => {
    const out = join(root, "verify.pack.json");
    runPackBuild(bundleDir, { out }, bufferIO());
    const ok = bufferIO();
    expect(runPackVerify(out, ok)).toBe(0);
    expect(ok.text()).toContain("OK");

    const envelope = JSON.parse(readFileSync(out, "utf8")) as {
      entries: Array<{ base64: string }>;
    };
    const entry = envelope.entries[0];
    if (!entry) throw new Error("expected at least one entry");
    entry.base64 = Buffer.from("tampered").toString("base64");
    const tampered = join(root, "tampered.pack.json");
    writeFileSync(tampered, JSON.stringify(envelope), "utf8");
    const bad = bufferIO();
    expect(runPackVerify(tampered, bad)).toBe(1);
    expect(bad.text()).toContain("REFUSED");
  });
});

describe("anvil pack install", () => {
  it("refuses an uncertified pack by default, and says how to proceed", async () => {
    const out = join(root, "install-src.pack.json");
    runPackBuild(bundleDir, { out }, bufferIO());
    const target = join(root, "installed-refused");
    const io = bufferIO();
    expect(await runPackInstall(out, { out: target }, io)).toBe(1);
    expect(io.text()).toContain("not 'certified'");
    expect(io.text()).toContain("--allow-uncertified");
    // Transactional: a refused install leaves nothing behind.
    expect(existsSync(target)).toBe(false);
  });

  it("installs with --allow-uncertified and records that choice", async () => {
    const out = join(root, "install-src.pack.json");
    const target = join(root, "installed");
    const io = bufferIO();
    expect(await runPackInstall(out, { out: target, allowUncertified: true }, io)).toBe(0);
    expect(io.text()).toContain("--allow-uncertified");
    expect(existsSync(join(target, "air.json"))).toBe(true);
    // The installed contract is byte-identical to the packed one.
    expect(readFileSync(join(target, "air.json"), "utf8")).toBe(
      readFileSync(join(bundleDir, "air.json"), "utf8"),
    );
  });

  it("never overwrites an existing target", async () => {
    const out = join(root, "install-src.pack.json");
    const target = join(root, "installed");
    const io = bufferIO();
    expect(await runPackInstall(out, { out: target, allowUncertified: true }, io)).toBe(1);
    expect(io.text()).toContain("already exists");
  });

  it("refuses a tampered pack before anything touches disk", async () => {
    const tampered = join(root, "tampered.pack.json");
    const target = join(root, "installed-tampered");
    const io = bufferIO();
    expect(await runPackInstall(tampered, { out: target, allowUncertified: true }, io)).toBe(1);
    expect(existsSync(target)).toBe(false);
  });

  it("installs a certified pack with no ceremony, and gates on the status word", async () => {
    // Write a certification whose status says certified; the ref is carried on
    // the envelope, so the gate reads the pack, not the wire.
    writeFileSync(
      join(bundleDir, "certification.json"),
      JSON.stringify({ status: "certified" }),
      "utf8",
    );
    const out = join(root, "certified.pack.json");
    runPackBuild(bundleDir, { out }, bufferIO());
    const target = join(root, "installed-certified");
    const io = bufferIO();
    expect(await runPackInstall(out, { out: target }, io)).toBe(0);
    expect(io.text()).toContain("certified — verified before anything touched disk");
    rmSync(join(bundleDir, "certification.json"));

    // A pack whose certification says failed is refused exactly like an
    // uncertified one — the gate is the word 'certified', nothing weaker.
    writeFileSync(
      join(bundleDir, "certification.json"),
      JSON.stringify({ status: "failed" }),
      "utf8",
    );
    const failedOut = join(root, "failed.pack.json");
    runPackBuild(bundleDir, { out: failedOut }, bufferIO());
    const failedIo = bufferIO();
    expect(await runPackInstall(failedOut, { out: join(root, "x") }, failedIo)).toBe(1);
    expect(failedIo.text()).toContain("'failed'");
    rmSync(join(bundleDir, "certification.json"));
  });

  it("refuses plain http, because content addressing is not confidentiality", async () => {
    const io = bufferIO();
    expect(await runPackInstall("http://example.com/pack.json", { out: join(root, "y") }, io)).toBe(
      1,
    );
    expect(io.text()).toContain("plain http");
  });
});
