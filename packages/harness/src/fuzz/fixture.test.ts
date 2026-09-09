import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processEnvironment } from "@anvil/fuzz";
import { afterEach, expect, it, vi } from "vitest";
import { startMockServer } from "../bundle-driver.js";

const roots: string[] = [];
function mock(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "anvil-fuzz-launcher-"));
  roots.push(dir);
  mkdirSync(join(dir, "mock"));
  writeFileSync(join(dir, "mock/server.mjs"), script);
  return dir;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("does not pass ambient application variables to a fuzz mock", async () => {
  vi.stubEnv("ANVIL_FUZZ_TEST_SECRET", "synthetic-marker");
  const dir = mock(
    `process.stderr.write(JSON.stringify({event:'listening',port:process.env.ANVIL_FUZZ_TEST_SECRET?1:0})+'\\n');setInterval(()=>{},1000);`,
  );
  const launched = await startMockServer(dir, { env: processEnvironment() });
  try {
    expect(launched.port).toBe(0);
  } finally {
    const closed = once(launched.child, "exit");
    launched.child.kill("SIGKILL");
    await closed;
  }
});

it("aborts mock startup and rejects an oversized ready stream", async () => {
  const controller = new AbortController();
  const pending = startMockServer(mock("setInterval(()=>{},1000)"), {
    env: processEnvironment(),
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toThrow();
  await expect(
    startMockServer(mock("process.stderr.write('x'.repeat(1100000));setInterval(()=>{},1000)"), {
      env: processEnvironment(),
    }),
  ).rejects.toThrow("output exceeded");
});
