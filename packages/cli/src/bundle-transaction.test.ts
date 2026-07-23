import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installGeneratedBundle } from "./commands/bundle-transaction.js";

describe("generated bundle transaction", () => {
  it("replaces the exact file set so stale generated files cannot survive", () => {
    const root = mkdtempSync(join(tmpdir(), "anvil-compile-transaction-"));
    const out = join(root, "bundle");
    mkdirSync(join(out, "schemas"), { recursive: true });
    writeFileSync(join(out, "schemas", "obsolete.json"), "old");
    writeFileSync(join(out, "air.yaml"), "old");
    writeFileSync(join(out, "air.json"), "{}");
    writeFileSync(join(out, "package.json"), "{}");
    writeFileSync(
      join(out, "generation.json"),
      '{"schemaVersion":1,"resourceOptions":{"mcpEndpoint":null,"cliNpmPackage":null,"cliOci":null}}',
    );
    writeFileSync(join(out, "NOTES.md"), "keep me");

    expect(
      installGeneratedBundle(out, {
        files: {
          "air.yaml": "new",
          "air.json": "{}",
          "package.json": "{}",
          "generation.json":
            '{"schemaVersion":1,"resourceOptions":{"mcpEndpoint":null,"cliNpmPackage":null,"cliOci":null}}',
          "schemas/current.json": "{}",
        },
      }),
    ).toEqual(["air.json", "air.yaml", "generation.json", "package.json", "schemas/current.json"]);
    expect(readFileSync(join(out, "air.yaml"), "utf8")).toBe("new");
    expect(existsSync(join(out, "schemas", "obsolete.json"))).toBe(false);
    expect(readFileSync(join(out, "NOTES.md"), "utf8")).toBe("keep me");
  });

  it("restores the prior directory if installation fails after creating partial output", () => {
    const root = mkdtempSync(join(tmpdir(), "anvil-compile-transaction-"));
    const out = join(root, "bundle");
    mkdirSync(out);
    writeFileSync(join(out, "air.yaml"), "prior");
    writeFileSync(join(out, "air.json"), "{}");
    writeFileSync(join(out, "package.json"), "{}");
    writeFileSync(
      join(out, "generation.json"),
      '{"schemaVersion":1,"resourceOptions":{"mcpEndpoint":null,"cliNpmPackage":null,"cliOci":null}}',
    );

    expect(() =>
      installGeneratedBundle(
        out,
        { files: { "air.yaml": "candidate" } },
        {
          installStage: (_stage, destination) => {
            mkdirSync(destination);
            writeFileSync(join(destination, "partial"), "bad");
            throw new Error("injected install failure");
          },
        },
      ),
    ).toThrow(/injected install failure/);
    expect(readFileSync(join(out, "air.yaml"), "utf8")).toBe("prior");
    expect(existsSync(join(out, "partial"))).toBe(false);
  });

  it("preserves the locked source store when workspace root and first output are the same", () => {
    const root = mkdtempSync(join(tmpdir(), "anvil-compile-transaction-"));
    const out = join(root, "bundle");
    mkdirSync(join(out, ".anvil", "sources"), { recursive: true });
    writeFileSync(join(out, ".anvil", "sources", "locked"), "source bytes");

    installGeneratedBundle(out, {
      files: {
        "air.yaml": "new",
        "air.json": "{}",
        "package.json": "{}",
        "generation.json":
          '{"schemaVersion":1,"resourceOptions":{"mcpEndpoint":null,"cliNpmPackage":null,"cliOci":null}}',
      },
    });
    expect(readFileSync(join(out, ".anvil", "sources", "locked"), "utf8")).toBe("source bytes");
    expect(readFileSync(join(out, "air.yaml"), "utf8")).toBe("new");
  });

  it("reports cleanup failure as a warning after a successful atomic swap", () => {
    const root = mkdtempSync(join(tmpdir(), "anvil-compile-transaction-"));
    const out = join(root, "bundle");
    mkdirSync(out);
    writeFileSync(join(out, "air.yaml"), "prior");
    writeFileSync(join(out, "air.json"), "{}");
    writeFileSync(join(out, "package.json"), "{}");
    writeFileSync(
      join(out, "generation.json"),
      '{"schemaVersion":1,"resourceOptions":{"mcpEndpoint":null,"cliNpmPackage":null,"cliOci":null}}',
    );
    const warnings: string[] = [];

    expect(
      installGeneratedBundle(
        out,
        {
          files: {
            "air.yaml": "new",
            "air.json": "{}",
            "package.json": "{}",
            "generation.json":
              '{"schemaVersion":1,"resourceOptions":{"mcpEndpoint":null,"cliNpmPackage":null,"cliOci":null}}',
          },
        },
        {
          removeBackup: () => {
            throw new Error("injected cleanup failure");
          },
          onCleanupWarning: (message) => warnings.push(message),
        },
      ),
    ).toContain("air.yaml");
    expect(readFileSync(join(out, "air.yaml"), "utf8")).toBe("new");
    expect(warnings).toEqual([
      expect.stringMatching(/installed successfully.*retained.*injected cleanup failure/i),
    ]);
    expect(readdirSync(root).some((name) => name.includes("compile-backup"))).toBe(true);
  });

  it("refuses an unmanaged existing directory without touching its sentinel", () => {
    const root = mkdtempSync(join(tmpdir(), "anvil-compile-transaction-"));
    const out = join(root, "not-a-bundle");
    mkdirSync(out);
    writeFileSync(join(out, "sentinel.txt"), "important");

    expect(() => installGeneratedBundle(out, { files: { "air.yaml": "candidate" } })).toThrow(
      /unmanaged output directory/i,
    );
    expect(readFileSync(join(out, "sentinel.txt"), "utf8")).toBe("important");
  });
});
