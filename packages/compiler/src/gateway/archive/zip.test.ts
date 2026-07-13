import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { readArchive } from "./reader.js";
import { ArchiveDecodeError, sniffArchiveFormat, ZipArchiveDecoder } from "./zip.js";

const decoder = new ZipArchiveDecoder();

describe("sniffArchiveFormat", () => {
  it("recognizes zip (and therefore jar/car) by magic, never by extension", () => {
    const zip = zipSync({ "config.yaml": strToU8("a: 1\n") });
    expect(sniffArchiveFormat(zip)).toBe("zip");
  });

  it("names gzip and tar so the refusal says what the file IS", () => {
    expect(sniffArchiveFormat(new Uint8Array([0x1f, 0x8b, 8, 0]))).toBe("gzip");
    const tar = new Uint8Array(512);
    tar.set(strToU8("ustar"), 257);
    expect(sniffArchiveFormat(tar)).toBe("tar");
    expect(sniffArchiveFormat(strToU8("just text"))).toBe("unknown");
  });
});

describe("ZipArchiveDecoder", () => {
  it("decodes a real zip byte-preserving through the security battery", () => {
    const bytes = zipSync({
      "kong.yaml": strToU8("_format_version: '3.0'\nservices: []\n"),
      "nested/readme.txt": strToU8("hello"),
    });
    const result = readArchive(bytes, decoder);
    expect(result.ok).toBe(true);
    expect(result.files.map((f) => f.path).sort()).toEqual(["kong.yaml", "nested/readme.txt"]);
    const kong = result.files.find((f) => f.path === "kong.yaml");
    expect(new TextDecoder().decode(kong?.bytes)).toBe("_format_version: '3.0'\nservices: []\n");
  });

  it("skips directory entries instead of emitting empty files", () => {
    const bytes = zipSync({ "dir/": new Uint8Array(0), "dir/file.txt": strToU8("x") });
    expect(decoder.decode(bytes).map((e) => e.path)).toEqual(["dir/file.txt"]);
  });

  it("flags unix symlink entries so normalizeArchive rejects them", () => {
    // fflate carries per-entry attributes into the central directory: os 3 =
    // UNIX, attrs high word = mode. S_IFLNK|0644 marks a symlink — the classic
    // escape smuggle a convenience unzip API would silently materialize.
    const bytes = zipSync({
      "safe.txt": strToU8("fine"),
      evil: [strToU8("../../etc/passwd"), { os: 3, attrs: (0xa1a4 << 16) >>> 0 }],
    });
    const entries = decoder.decode(bytes);
    expect(entries.find((e) => e.path === "evil")?.isSymlink).toBe(true);
    expect(entries.find((e) => e.path === "safe.txt")?.isSymlink).toBe(false);

    const result = readArchive(bytes, decoder);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "archive/symlink_rejected")).toBe(true);
    expect(result.files.map((f) => f.path)).toEqual(["safe.txt"]);
  });

  it("zip-slip entries survive decode but die in normalization, reported", () => {
    const bytes = zipSync({ "../escape.txt": strToU8("out"), "ok.txt": strToU8("in") });
    const result = readArchive(bytes, decoder);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "archive/unsafe_path")).toBe(true);
    expect(result.files.map((f) => f.path)).toEqual(["ok.txt"]);
  });

  it("refuses non-zip bytes with a typed error that names the actual format", () => {
    expect(() => decoder.decode(strToU8("not an archive"))).toThrow(ArchiveDecodeError);
    const tar = new Uint8Array(512);
    tar.set(strToU8("ustar"), 257);
    expect(() => decoder.decode(tar)).toThrow(/container is tar/);
  });

  it("refuses corrupt zips (valid magic, broken body) as undecodable", () => {
    const bytes = zipSync({ "a.txt": strToU8("abc") });
    const corrupt = bytes.slice(0, Math.floor(bytes.length / 2));
    // Keep the magic so it sniffs as zip, then fail inflation.
    expect(() => decoder.decode(corrupt)).toThrow(ArchiveDecodeError);
  });
});
