import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  assessLegacyBridgeDriver,
  LegacyBridgeDriverDescriptor,
  LegacyBridgePlan,
  LegacyBridgeSupportAssessment,
  LegacyCapabilityBinding,
  planLegacyBridge,
} from "@anvil/compiler/legacy";
import type { Command } from "commander";
import { z } from "zod";
import { emitRefusal } from "../../envelope.js";
import type { CliIO } from "../../io.js";
import type { CommandContext } from "../context.js";
import { annotate } from "../meta.js";

const REPORT_TYPE = "anvil.legacy-bridge-plan";
const ERROR_REPORT_TYPE = "anvil.legacy-bridge-plan-error";
const MAX_INPUT_BYTES = 32 * 1024 * 1024;

const BridgePlanReport = z
  .object({
    schemaVersion: z.literal(1),
    reportType: z.literal(REPORT_TYPE),
    plan: LegacyBridgePlan,
    driverAssessment: LegacyBridgeSupportAssessment.optional(),
  })
  .strict();

interface BridgePlanOptions {
  driver?: string;
  out?: string;
  json?: boolean;
}

class LegacyBridgeCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function registerLegacyBridge(parent: Command, ctx: CommandContext): void {
  const bridge = parent
    .command("bridge")
    .summary("Plan and assess a deployment-local bridge for an approved binding.")
    .description(
      "Produces a deterministic, non-executable runtime contract from an approved legacy binding. It never loads a driver, connects to the estate, accepts credentials, or treats a plan as live readiness.",
    );

  annotate(
    bridge
      .command("plan")
      .summary("Create a content-addressed bridge contract and conformance requirements.")
      .argument("<decision>", "approved refinement decision report or capability binding JSON")
      .option("--driver <file>", "statically assess a driver descriptor without loading it")
      .option("--out <file>", "write without overwriting different content")
      .option("--json", "emit the complete bridge plan")
      .action((decision: string, options: BridgePlanOptions) => {
        ctx.code = runBridgePlan(decision, options, ctx.io);
      }),
    { mutates: true },
  );
}

function runBridgePlan(decisionPath: string, options: BridgePlanOptions, io: CliIO): number {
  try {
    const binding = readBinding(decisionPath);
    const plan = planLegacyBridge(binding);
    const driverAssessment = options.driver
      ? assessLegacyBridgeDriver(plan, LegacyBridgeDriverDescriptor.parse(readJson(options.driver)))
      : undefined;
    const report = BridgePlanReport.parse({
      schemaVersion: 1,
      reportType: REPORT_TYPE,
      plan,
      ...(driverAssessment ? { driverAssessment } : {}),
    });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.out) writeReport(options.out, serialized);
    if (options.json) io.out(serialized.trimEnd());
    else {
      io.out(`Legacy bridge plan ${plan.planId}`);
      io.out(`  operation: ${plan.operationName}`);
      io.out(`  ${plan.requiredCapabilities.length} required driver capability(s)`);
      io.out(`  ${plan.conformance.length} required conformance case(s)`);
      io.out(
        "  execution: blocked until a compatible driver passes conformance and live readiness",
      );
      if (driverAssessment) {
        io.out(
          `  driver ${driverAssessment.driverId}: ${driverAssessment.supported ? "contract compatible" : "unsupported"}`,
        );
      }
      if (options.out) io.out(`  report: ${options.out}`);
    }
    return driverAssessment && !driverAssessment.supported ? 1 : 0;
  } catch (error) {
    return emitRefusal(io, options.json, {
      reportType: ERROR_REPORT_TYPE,
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
      details: { decision: decisionPath, ...(options.driver ? { driver: options.driver } : {}) },
    });
  }
}

function readBinding(path: string): z.infer<typeof LegacyCapabilityBinding> {
  const value = readJson(path);
  if (value && typeof value === "object" && "binding" in value) {
    const binding = (value as { binding?: unknown }).binding;
    if (!binding) {
      throw new LegacyBridgeCommandError(
        "legacy/bridge_binding_missing",
        "The decision does not contain an approved capability binding.",
      );
    }
    return LegacyCapabilityBinding.parse(binding);
  }
  return LegacyCapabilityBinding.parse(value);
}

function readJson(path: string): unknown {
  const target = resolve(path);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new LegacyBridgeCommandError(
      "legacy/bridge_input_refused",
      `Refused '${path}': expected a regular, non-symbolic-link JSON file.`,
    );
  }
  if (stat.size > MAX_INPUT_BYTES) {
    throw new LegacyBridgeCommandError(
      "legacy/bridge_input_too_large",
      `Refused '${path}': input exceeds ${MAX_INPUT_BYTES} bytes.`,
    );
  }
  try {
    return JSON.parse(readFileSync(target, "utf8")) as unknown;
  } catch {
    throw new LegacyBridgeCommandError(
      "legacy/bridge_input_invalid",
      `Refused '${path}': input is not valid JSON.`,
    );
  }
}

function writeReport(path: string, content: string): void {
  const target = resolve(path);
  if (existsSync(target)) {
    if (readFileSync(target, "utf8") === content) return;
    throw new LegacyBridgeCommandError(
      "legacy/bridge_output_exists",
      `Refused to overwrite different legacy bridge output '${path}'.`,
    );
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
}

function errorCode(error: unknown): string {
  if (error instanceof LegacyBridgeCommandError) return error.code;
  const nodeCode =
    error !== null && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  if (["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(nodeCode ?? "")) {
    return "legacy/bridge_input_unreadable";
  }
  if (error instanceof z.ZodError) return "legacy/bridge_input_invalid";
  return "legacy/bridge_plan_failed";
}
