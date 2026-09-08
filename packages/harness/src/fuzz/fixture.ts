import { type JsonValue, processEnvironment, type Step } from "@anvil/fuzz";
import { MockControl, startMockServer } from "../bundle-driver.js";

export interface FuzzFixture {
  baseUrl: string;
  before(step: Step): Promise<void>;
  observe(): Promise<{ wire: JsonValue; effects?: JsonValue }>;
  close(): Promise<void>;
}
export type FuzzFixtureFactory = (
  bundle: string,
  seed: number,
  signal: AbortSignal,
) => Promise<FuzzFixture>;

/** The generic lane proves AIR/wire consistency, not business-state correctness. */
export const generatedMockFixture: FuzzFixtureFactory = async (bundle, _seed, signal) => {
  const mock = await startMockServer(bundle, { env: processEnvironment(), signal });
  const baseUrl = `http://127.0.0.1:${mock.port}`;
  const control = new MockControl(baseUrl);
  const kill = () => mock.child.kill("SIGKILL");
  signal.addEventListener("abort", kill, { once: true });
  if (signal.aborted) kill();
  return {
    baseUrl,
    async before(step) {
      if (step.fault) {
        if (step.fault.kind !== "http-status" || typeof step.fault.status !== "number")
          throw new Error("Unsupported mock fault");
        await control.fault(step.operation, step.fault.status, 1);
      }
    },
    async observe() {
      const captures = await control.capture();
      return {
        wire: captures.map((c) => ({
          method: c.method,
          path: c.path,
          query: c.query,
          headers: c.headers,
          body: c.body as JsonValue,
          contentType: c.contentType,
        })),
      };
    },
    async close() {
      signal.removeEventListener("abort", kill);
      kill();
      if (mock.child.exitCode === null && mock.child.signalCode === null)
        await new Promise<void>((resolve) => mock.child.once("exit", () => resolve()));
    },
  };
};
