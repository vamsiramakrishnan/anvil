import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Operation, operationSafetyInputKeys } from "@anvil/air";
import {
  type Driver,
  type DriverSession,
  Outcome,
  processEnvironment,
  runProcess,
} from "@anvil/fuzz";
import {
  loadBundleAir,
  readBundleDir,
  SDK_LANGUAGES,
  type SdkLanguage,
  sdkPlan,
  writeBundle,
} from "@anvil/generators";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cliFlagsFor, ensureBundleNodeModules, hermeticCredentialEnv } from "../bundle-driver.js";
import { connectSource, type McpSource } from "../mcp-source.js";
import { type FuzzFixture, type FuzzFixtureFactory, generatedMockFixture } from "./fixture.js";

import { prepareSdk, type SdkInvocation, type SdkToolchains } from "./sdk-driver.js";

export const FUZZ_SURFACES = ["mcp", "cli", "cli-mcp", ...SDK_LANGUAGES] as const;
export type FuzzSurface = (typeof FUZZ_SURFACES)[number];
export interface BundleDriverOptions extends SdkToolchains {
  surfaces?: FuzzSurface[];
  cliPackageDir?: string;
  fixture?: FuzzFixtureFactory;
}

function decoded(text: string, isError: boolean): Outcome {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    if (isError && text.startsWith("MCP error -32602: Input validation error:"))
      return { status: "error", value: null, errorCode: "invalid_arguments" };
    return { status: "inconclusive", value: null, errorCode: "invalid_output_envelope" };
  }
  if (isError) {
    const error =
      (value as { error?: { code?: string }; code?: string })?.error ??
      (value as { code?: string });
    return { status: "error", value: null, errorCode: error?.code ?? "surface_error" };
  }
  return Outcome.parse({ status: "ok", value });
}

/** Copies the EXACT bundle bytes. Generated client mutations remain observable. */
export function bundleFuzzDrivers(
  bundle: string | Record<string, string>,
  options: BundleDriverOptions = {},
): Driver[] {
  const files = typeof bundle === "string" ? readBundleDir(bundle) : { ...bundle };
  const air = loadBundleAir(typeof bundle === "string" ? bundle : "bundle snapshot", files);
  const operations = new Map(air.operations.map((op) => [op.id, op]));
  const plan = sdkPlan(air);
  const sdkOperations = new Map(plan.operations.map((op) => [op.id, op]));
  return (options.surfaces ?? ["mcp", "cli", "python"]).map(
    (surface): Driver => ({
      id: surface,
      async open({ seed, signal }) {
        if ((surface === "cli" || surface === "cli-mcp") && !options.cliPackageDir)
          return unavailable("cli_package_missing");
        const dir = mkdtempSync(join(tmpdir(), "anvil-fuzz-"));
        let fixture: FuzzFixture | undefined;
        let source: McpSource | undefined;
        let sdkClient: SdkInvocation | undefined;
        let closed = false;
        const close = async () => {
          if (closed) return;
          closed = true;
          try {
            await source?.close();
          } finally {
            try {
              await fixture?.close();
            } finally {
              rmSync(dir, { recursive: true, force: true });
            }
          }
        };
        try {
          writeBundle(dir, { files });
          ensureBundleNodeModules(
            dir,
            options.cliPackageDir ? [{ name: "@anvil/cli", dir: options.cliPackageDir }] : [],
          );
          if ((SDK_LANGUAGES as readonly string[]).includes(surface))
            sdkClient = await prepareSdk(surface as SdkLanguage, plan, files, dir, options, signal);
          fixture = await (options.fixture ?? generatedMockFixture)(dir, seed, signal);
          if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(fixture.baseUrl))
            throw new Error("Fuzz fixtures must bind loopback");
          const base = fixture.baseUrl;
          const env = {
            ...hermeticCredentialEnv(air.operations, base),
            ANVIL_BASE_URL: base,
            ANVIL_ENV: "dev",
            ANVIL_ALLOWED_HOSTS: "127.0.0.1",
            ANVIL_AUTH_PROFILE: "default",
            ANVIL_LEDGER: "",
            ANVIL_PROTOCOL_FACADE: "Anvil fuzz fixture serving the declared wire coordinates",
          };
          if (surface === "mcp") {
            source = await connectSource(
              {
                id: "fuzz",
                system: "generic",
                transport: {
                  kind: "stdio",
                  command: process.execPath,
                  args: [join(dir, "mcp/server.js")],
                  env,
                },
                hints: { scope: [] },
              },
              async () =>
                new StdioClientTransport({
                  command: process.execPath,
                  args: [join(dir, "mcp/server.js")],
                  env: processEnvironment(env),
                }),
            );
          }
          if (signal.aborted) {
            await close();
            throw new Error("Driver opened after cancellation");
          }
          return {
            async invoke(step, callSignal) {
              const op = operations.get(step.operation);
              if (op?.state !== "approved")
                return { status: "unsupported", value: null, errorCode: "operation_not_approved" };
              if (op.auth.type === "oauth2_on_behalf_of" || op.auth.tls)
                return {
                  status: "unsupported",
                  value: null,
                  errorCode: "identity_fixture_required",
                };
              await fixture?.before(step);
              let outcome: Outcome;
              if (surface === "mcp") {
                const abort = () => {
                  void source?.close();
                };
                callSignal.addEventListener("abort", abort, { once: true });
                try {
                  const raw = await (source as McpSource).callRaw(op.mcp.toolName, step.input);
                  outcome = decoded(raw.text, raw.isError);
                } finally {
                  callSignal.removeEventListener("abort", abort);
                }
              } else if (sdkClient) {
                const sdk = sdkOperations.get(op.id);
                if (!sdk)
                  return { status: "unsupported", value: null, errorCode: "sdk_operation_missing" };
                outcome = await sdkClient.invoke(sdk, step, base, env, callSignal);
              } else {
                const raw = await runProcess(
                  {
                    command: process.execPath,
                    args: [
                      join(dir, "cli", `${air.service.id}.mjs`),
                      ...op.cli.command.split(" ").slice(1),
                      ...flags(op, step.input),
                      ...(surface === "cli-mcp" ? ["--mcp", "stdio"] : []),
                      "--base-url",
                      base,
                      "--json",
                    ],
                    cwd: dir,
                    env,
                  },
                  "",
                  callSignal,
                );
                outcome = decoded(raw.stdout || raw.stderr, raw.exitCode !== 0);
              }
              return { ...outcome, ...(await (fixture as FuzzFixture).observe()) };
            },
            close,
          };
        } catch (error) {
          await close();
          throw error;
        }
      },
    }),
  );
}

function flags(op: Operation, input: Record<string, unknown>): string[] {
  const keys = operationSafetyInputKeys(op);
  return [...cliFlagsFor(op, input), ...(input[keys.confirm] === true ? ["--confirm"] : [])];
}
function unavailable(code: string): DriverSession {
  return {
    async invoke() {
      return { status: "unsupported", value: null, errorCode: code };
    },
    async close() {},
  };
}
