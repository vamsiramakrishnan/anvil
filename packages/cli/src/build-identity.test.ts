import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { buildIdentity } from "./build-identity.js";
import { bufferIO } from "./io.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A CLI package and one Anvil dependency, installed the way pnpm links a workspace. */
function install(): { cli: string; air: string; moduleUrl: string } {
  const root = mkdtempSync(join(tmpdir(), "anvil-build-identity-"));
  roots.push(root);
  const pkg = (dir: string, manifest: Record<string, unknown>, files: Record<string, string>) => {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "dist", name), text);
  };
  const cli = join(root, "cli");
  const air = join(root, "air");
  pkg(
    cli,
    { name: "@anvil/cli", dependencies: { "@anvil/air": "*", commander: "*" } },
    {
      "bin.js": "run()",
      "build-info.json": JSON.stringify({ commit: "abc123" }),
    },
  );
  pkg(air, { name: "@anvil/air" }, { "index.js": "export {}" });
  mkdirSync(join(cli, "node_modules", "@anvil"), { recursive: true });
  symlinkSync(air, join(cli, "node_modules", "@anvil", "air"), "dir");
  return { cli, air, moduleUrl: pathToFileURL(join(cli, "dist", "bin.js")).href };
}

describe("the build identity", () => {
  it("digests every Anvil package the CLI loads, and names the commit it was built at", () => {
    const { moduleUrl } = install();
    const identity = buildIdentity("0.1.0", moduleUrl);
    expect(identity).toMatchObject({ name: "anvil", version: "0.1.0", commit: "abc123" });
    expect(Object.keys(identity.packages)).toEqual(["@anvil/air", "@anvil/cli"]);
    expect(identity.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // A pure function of the built files.
    expect(buildIdentity("0.1.0", moduleUrl)).toEqual(identity);
  });

  it("changes when a dependency's build changes, and not when only the commit does", () => {
    const { cli, air, moduleUrl } = install();
    const before = buildIdentity("0.1.0", moduleUrl);
    writeFileSync(join(cli, "dist", "build-info.json"), JSON.stringify({ commit: "def456" }));
    const recommitted = buildIdentity("0.1.0", moduleUrl);
    expect(recommitted.commit).toBe("def456");
    expect(recommitted.digest).toBe(before.digest);

    writeFileSync(join(air, "dist", "index.js"), "export const changed = true;");
    const rebuilt = buildIdentity("0.1.0", moduleUrl);
    expect(rebuilt.digest).not.toBe(before.digest);
    expect(rebuilt.packages["@anvil/air"]).not.toBe(before.packages["@anvil/air"]);
    expect(rebuilt.packages["@anvil/cli"]).toBe(before.packages["@anvil/cli"]);
  });

  it("is what `anvil --version --json` prints, while `--version` alone stays the version", async () => {
    for (const argv of [
      ["--version", "--json"],
      ["--json", "-V"],
    ]) {
      const io = bufferIO();
      expect(await runAnvilCli(argv, { io })).toBe(0);
      const printed = JSON.parse(io.stdout.join("\n")) as Record<string, unknown>;
      expect(printed).toMatchObject({ name: "anvil", version: "0.1.0" });
      expect(printed.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    const io = bufferIO();
    expect(await runAnvilCli(["--version"], { io })).toBe(0);
    expect(io.stdout.join("\n")).toBe("0.1.0");
  });
});
