import type { Plugin, PluginOption } from "vite";
import { describe, expect, it, vi } from "vitest";

/**
 * `vite.config.ts` must load without side effects: knip evaluates it before
 * anything is built, and the dev mock it mounts imports `contract.ts`, whose
 * `@anvil/*` imports resolve to `dist` entry points that a fresh checkout does
 * not have. Loading the config once eagerly imported the mock and knip failed
 * with `Cannot read properties of undefined (reading 'shape')`.
 *
 * The counters below are bumped by module factories that wrap the real
 * modules, so they count actual loads of the mock and of the contract — not a
 * static import statement — and the assertion is on the module graph itself.
 */

const loads = vi.hoisted(() => ({ mock: 0, contract: 0 }));

vi.mock("./mock-server.js", async (importOriginal) => {
  loads.mock += 1;
  return importOriginal();
});
vi.mock("../../contract.js", async (importOriginal) => {
  loads.contract += 1;
  return importOriginal();
});

function flatten(options: PluginOption[]): Plugin[] {
  const out: Plugin[] = [];
  for (const option of options) {
    if (Array.isArray(option)) out.push(...flatten(option));
    else if (option && typeof option === "object" && "name" in option) out.push(option);
  }
  return out;
}

describe("vite.config.ts", () => {
  it("loads without importing the dev mock or the contract, and only mounts the mock for `serve`", async () => {
    const config = (await import("../../../vite.config.js")).default;
    expect(loads.mock, "loading the config imported the dev mock").toBe(0);
    expect(loads.contract, "loading the config imported contract.ts").toBe(0);
    if (typeof config === "function") throw new Error("the config is a plain object");

    const plugin = flatten(config.plugins ?? []).find((p) => p.name === "anvil-console-mock-api");
    if (!plugin) throw new Error("the mock plugin is not registered");
    expect(plugin.apply).toBe("serve");

    // The page is served with an empty token until the dev server has started
    // — the mock, and with it the contract, is pulled in by `configureServer`.
    const transform = plugin.transformIndexHtml;
    const hook = typeof transform === "function" ? transform : transform?.handler;
    if (typeof hook !== "function") throw new Error("no transformIndexHtml hook");
    const before = await hook.call({} as never, "<html><head></head></html>", {
      path: "/",
      filename: "index.html",
    } as never);
    expect(before).toContain('<meta name="anvil-console-token" content="">');
    expect(loads.contract).toBe(0);

    const configure = plugin.configureServer;
    const setup = typeof configure === "function" ? configure : configure?.handler;
    if (typeof setup !== "function") throw new Error("no configureServer hook");
    const use = vi.fn();
    await setup.call({} as never, { middlewares: { use } } as never);
    expect(use).toHaveBeenCalledTimes(1);
    expect(loads.mock).toBe(1);
    expect(loads.contract).toBe(1);

    const after = await hook.call({} as never, "<html><head></head></html>", {
      path: "/",
      filename: "index.html",
    } as never);
    expect(after).toMatch(/<meta name="anvil-console-token" content="[0-9a-f]{32}">/);
  });
});
