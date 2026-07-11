import { describe, expect, it } from "vitest";
import { archiveEntries, InMemoryArchiveDecoder } from "./fixture.js";
import type { ArchiveLimits } from "./model.js";
import { decodeArchiveText, normalizeArchive, readArchive } from "./reader.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("archive normalization — happy path", () => {
  it("decodes a clean export into sorted, byte-preserving files", () => {
    const decoder = new InMemoryArchiveDecoder(
      archiveEntries({ "services.yaml": "a: 1\n", "routes/r.yaml": "b: 2\n" }),
    );
    const result = readArchive(enc("ignored"), decoder);
    expect(result.ok).toBe(true);
    expect(result.files.map((f) => f.path)).toEqual(["routes/r.yaml", "services.yaml"]);
    expect(decodeArchiveText(result.files[1]!)).toEqual({ ok: true, text: "a: 1\n" });
  });

  it("dedupes an identical duplicate path", () => {
    const result = normalizeArchive(
      archiveEntries({}, [
        { path: "x.yaml", bytes: enc("same") },
        { path: "x.yaml", bytes: enc("same") },
      ]),
    );
    expect(result.ok).toBe(true);
    expect(result.files).toHaveLength(1);
  });
});

describe("archive normalization — security battery", () => {
  const cases: { name: string; entries: Parameters<typeof normalizeArchive>[0]; code: string }[] = [
    {
      name: "absolute path",
      entries: [{ path: "/etc/passwd", bytes: enc("x") }],
      code: "archive/unsafe_path",
    },
    {
      name: "parent traversal",
      entries: [{ path: "../../escape.yaml", bytes: enc("x") }],
      code: "archive/unsafe_path",
    },
    {
      name: "backslash separator",
      entries: [{ path: "a\\b.yaml", bytes: enc("x") }],
      code: "archive/unsafe_path",
    },
    {
      name: "symlink",
      entries: [{ path: "link", bytes: enc("/etc"), isSymlink: true }],
      code: "archive/symlink_rejected",
    },
    {
      name: "conflicting duplicate",
      entries: [
        { path: "x.yaml", bytes: enc("one") },
        { path: "x.yaml", bytes: enc("two") },
      ],
      code: "archive/duplicate_path",
    },
  ];

  for (const c of cases) {
    it(`rejects ${c.name}`, () => {
      const result = normalizeArchive(c.entries);
      expect(result.ok).toBe(false);
      expect(result.diagnostics.map((d) => d.code)).toContain(c.code);
    });
  }

  it("enforces per-file, expanded-size, count, and depth limits", () => {
    const limits: ArchiveLimits = {
      maxFiles: 2,
      maxFileBytes: 4,
      maxExpandedBytes: 6,
      maxDepth: 2,
    };
    const big = normalizeArchive([{ path: "big.bin", bytes: enc("toolong") }], limits);
    expect(big.diagnostics.map((d) => d.code)).toContain("archive/file_too_large");

    const deep = normalizeArchive([{ path: "a/b/c/d.yaml", bytes: enc("x") }], limits);
    expect(deep.diagnostics.map((d) => d.code)).toContain("archive/too_deep");

    const many = normalizeArchive(
      [
        { path: "a.txt", bytes: enc("aa") },
        { path: "b.txt", bytes: enc("bb") },
        { path: "c.txt", bytes: enc("cc") },
      ],
      limits,
    );
    expect(many.diagnostics.map((d) => d.code)).toContain("archive/too_many_files");

    const expand = normalizeArchive(
      [
        { path: "a.txt", bytes: enc("aaaa") },
        { path: "b.txt", bytes: enc("bbbb") },
      ],
      limits,
    );
    expect(expand.diagnostics.map((d) => d.code)).toContain("archive/expanded_too_large");
  });

  it("reports invalid UTF-8 instead of silently mangling it", () => {
    const bad = normalizeArchive([{ path: "x.bin", bytes: new Uint8Array([0xff, 0xfe, 0xff]) }]);
    const file = bad.files[0];
    expect(file).toBeDefined();
    expect(decodeArchiveText(file!).ok).toBe(false);
  });
});
