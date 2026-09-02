import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One workspace for the whole run, built with the REAL CLI:
 *
 *   1. `anvil compile` over `examples/payments` — the spec the contract tests
 *      and the server tests compile — with a manifest that marks the two read
 *      operations `review_required` (they compile as `generated` otherwise, so
 *      there would be no review-tier read to approve), and one deliberate
 *      addition to the spec: the same boilerplate `description` on the two
 *      operations of the `payments` capability. The deterministic executor
 *      grounds every proposal it makes, so on the pristine spec every
 *      refinement `anvil refine run` produces is auto-tier and nothing awaits
 *      a receipt; two siblings with an indistinct description is the
 *      smallest honest deficiency that routes to a human, so the queue has a
 *      pack decision to make and a receipt to prove.
 *   2. `anvil refine run --out` for that pack.
 *   3. `anvil console <root> --port <free> --json`, kept running for every
 *      scenario and stopped in the teardown. Its stderr (request lines) is
 *      collected and never printed; its stdout is the one JSON document.
 *
 * What the tests need travels to the workers as an environment variable —
 * paths and ids only. The per-process token stays in the served page.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(packageRoot, "..", "..");
const CLI = join(repoRoot, "packages", "cli", "dist", "bin-anvil.js");
const UI = join(packageRoot, "dist", "ui", "index.html");
const EXAMPLE_SPEC = join(repoRoot, "examples", "payments", "openapi.yaml");

export const STATE_ENV = "ANVIL_CONSOLE_E2E";

export interface E2EState {
  url: string;
  root: string;
  bundleId: string;
  bundleDir: string;
  packDir: string;
  cli: string;
  /** The review-tier refinement `anvil refine run` produced — the pack decision to make. */
  refinementId: string;
  /** The two reads the manifest marked `review_required`, in spec order. */
  reviewReads: [string, string];
  /** The non-idempotent financial mutation no policy may select. */
  nonIdempotentMutation: string;
  /** The `proposed` capability to reject. */
  capabilityToReject: string;
}

export function readState(): E2EState {
  const raw = process.env[STATE_ENV];
  if (!raw) throw new Error(`${STATE_ENV} is not set: global-setup did not run`);
  return JSON.parse(raw) as E2EState;
}

const INDISTINCT = "Works with one payment.";

/** The example spec with the same description on `getPayment` and `capturePayment`. */
function specWithIndistinctSiblings(): string {
  const source = readFileSync(EXAMPLE_SPEC, "utf8");
  const patched = source
    .replace(
      "      summary: Get a payment\n",
      `      summary: Get a payment\n      description: ${INDISTINCT}\n`,
    )
    .replace(
      "      summary: Capture a payment\n",
      `      summary: Capture a payment\n      description: ${INDISTINCT}\n`,
    );
  const inserted = patched.split(INDISTINCT).length - 1;
  if (inserted !== 2) {
    throw new Error(
      `examples/payments/openapi.yaml changed shape: expected to describe 2 operations, described ${inserted}`,
    );
  }
  return patched;
}

function anvil(cwd: string, ...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitFor(check: () => Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Launch `anvil console --json` and parse the one document it prints. */
async function launchConsole(root: string, port: number) {
  const child: ChildProcess = spawn(
    process.execPath,
    [CLI, "console", root, "--port", String(port), "--json"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  const stderr: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  let document: { reportType?: string; url?: string; port?: number; root?: string } | undefined;
  await waitFor(async () => {
    if (exited) throw new Error(`anvil console exited early:\n${stdout}\n${stderr.join("")}`);
    try {
      document = JSON.parse(stdout) as typeof document;
      return true;
    } catch {
      return false;
    }
  }, "`anvil console --json` to print its document");
  if (document?.reportType !== "anvil.console" || typeof document.url !== "string") {
    throw new Error(`unexpected console document: ${stdout}`);
  }
  if (document.url !== `http://127.0.0.1:${port}`) {
    throw new Error(`the console did not bind the requested port: ${document.url}`);
  }
  const url = document.url;
  await waitFor(
    async () => (await fetch(`${url}/api/workspace`)).status === 200,
    "the console to answer /api/workspace",
  );
  return { child, url };
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  for (const [what, path] of [
    ["the built CLI", CLI],
    ["the built console UI", UI],
  ] as const) {
    if (!existsSync(path)) {
      throw new Error(`${what} is missing (${path}); run \`pnpm build\` before \`pnpm test:e2e\``);
    }
  }

  const root = mkdtempSync(join(tmpdir(), "anvil-console-e2e-"));
  const specPath = join(root, "openapi.yaml");
  const manifestPath = join(root, "anvil.yaml");
  writeFileSync(specPath, specWithIndistinctSiblings(), "utf8");
  writeFileSync(
    manifestPath,
    [
      "# The two reads compile as `generated` on their own; the console exists to",
      "# decide review-tier operations, so the manifest puts them in review.",
      "operations:",
      "  getPayment:",
      "    state: review_required",
      "  getCustomer:",
      "    state: review_required",
      "",
    ].join("\n"),
    "utf8",
  );
  const bundleId = "payments";
  const bundleDir = join(root, bundleId);
  anvil(root, "compile", specPath, "--manifest", manifestPath, "--out", bundleDir, "--root", root);
  // The compile's source lock lives under <root>/.anvil/sources; the console's
  // scratch directory (<root>/.anvil/console) must not exist until a mutation
  // that needs it runs, and no scenario here runs one.
  const packDir = join(root, "packs", "first");
  anvil(root, "refine", "run", bundleDir, "--out", packDir);
  const pack = JSON.parse(readFileSync(join(packDir, "pack.json"), "utf8")) as {
    refinements: Array<{ id: string; status: string; approval: { tier: string } }>;
  };
  const awaiting = pack.refinements.filter(
    (r) => r.approval.tier === "review" && (r.status === "improved" || r.status === "neutral"),
  );
  const refinementId = awaiting[0]?.id;
  if (!refinementId) {
    throw new Error("the refinement pack holds no review-tier refinement to decide");
  }

  const port = await freePort();
  const { child, url } = await launchConsole(root, port);

  const state: E2EState = {
    url,
    root,
    bundleId,
    bundleDir,
    packDir,
    cli: CLI,
    refinementId,
    reviewReads: ["payments_api.payments.get", "payments_api.customers.get"],
    nonIdempotentMutation: "payments_api.refunds.create",
    capabilityToReject: "payments_api.refunds",
  };
  process.env[STATE_ENV] = JSON.stringify(state);

  return async () => {
    const exited = new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) resolveExit();
      else child.once("exit", () => resolveExit());
    });
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  };
}
