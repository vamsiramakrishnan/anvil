import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("compiles and previews business contracts without modifying sources or approving proposed actions", async () => {
  const root = fileURLToPath(new URL("../../../examples/business", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "anvil-business-cli-"));
  dirs.push(dir);
  const out = join(dir, "bundle");
  const definition = readFileSync(join(root, "definition.json"), "utf8");
  const args = [
    "capability",
    "compile",
    join(root, "definition.json"),
    "--source",
    ...["orders", "billing", "identity", "support"].map(
      (name) => `${name}=${join(root, "sources", `${name}.json`)}`,
    ),
    "--out",
    out,
    "--json",
  ];
  const io = bufferIO();
  expect(await runAnvilCli(args, { io }), io.text()).toBe(0);
  expect(JSON.parse(io.stdout[0] ?? "{}").business.actions).toHaveLength(3);
  const publicView = bufferIO();
  expect(
    await runAnvilCli(["capability", "preview", out], { io: publicView }),
    publicView.text(),
  ).toBe(0);
  expect(publicView.text()).toContain("complete_return");
  expect(publicView.text()).not.toContain("raw_order_lookup");
  const execution = bufferIO();
  expect(await runAnvilCli(["capability", "preview", out, "--execution"], { io: execution })).toBe(
    0,
  );
  expect(execution.text()).toContain("raw_order_lookup");
  expect(execution.text()).toContain("authoritative payment link");
  const duplicate = bufferIO();
  expect(await runAnvilCli(args, { io: duplicate })).toBe(1);
  expect(duplicate.text()).toContain("Output exists");
  expect(readFileSync(join(root, "definition.json"), "utf8")).toBe(definition);
}, 30_000);
