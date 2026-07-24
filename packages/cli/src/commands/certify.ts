import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { airFromJson, airFromYaml } from "@anvil/air";
import { certify as assessStaticContract } from "@anvil/certification";
import {
  CERTIFICATION_FILE,
  type Certification,
  type CertificationCheck,
  type CertificationGate,
  type Clock,
  certifyBundle,
  readBundleDir,
} from "@anvil/generators";
import { GEMINI_ENTERPRISE_PROFILE, verifyTargetKit } from "@anvil/targets";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil certify <dir|air.yaml>` — run static assurance gates over a generated
 * bundle and write `certification.json` into it. This proves byte/contract
 * coherence; it does not boot a generated surface. `selftest`, `conformance`,
 * and `simulate` produce the executable evidence.
 */
export function registerCertify(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("certify")
      .summary("Run static bundle-assurance gates and write certification.json.")
      .description(
        "Static assurance only: four deterministic gates judge the bundle as emitted. CONTRACT re-validates AIR, generated-surface alignment, and persisted target-kit regeneration; SAFETY checks confirmation, retry/idempotency, and secret handling; SEMANTIC checks descriptions and routing; RUNTIME checks generated mocks, evals, conformance tests, and deploy artifacts. The record binds to a content hash, so generated-byte tampering invalidates it. It does not boot or invoke a surface; use `anvil selftest`, `anvil conformance`, and `anvil simulate` for executable evidence.",
      )
      .argument("<path>", "bundle directory or its air.yaml")
      .option("--json", "emit the full certification as JSON")
      .action((path: string, opts: CertifyOptions) => {
        ctx.code = runCertify(path, opts, ctx.io);
      }),
    { mutates: true },
  );
}

export interface CertifyOptions {
  json?: boolean;
}

/** The certify action, exported with an injectable clock so tests can pin time. */
export function runCertify(
  path: string,
  opts: CertifyOptions,
  io: CliIO,
  deps: { now?: Clock } = {},
): number {
  const dir = resolveBundleDir(path);
  const files = readBundleDir(dir);
  const air = loadBundleAir(dir, files);

  const cert = certifyBundle(files, air, { now: deps.now });
  // Bridge the generated-byte judgement to the canonical certification
  // attestation model. This remains static: executable=false is intentional.
  const canonical = assessStaticContract(air);
  if (canonical.status !== "failed" && canonical.status !== "static_passed") {
    throw new Error(`Static assurance returned unexpected status "${canonical.status}".`);
  }
  cert.assurance = {
    level: "static",
    engine: "@anvil/certification",
    engineStatus: canonical.status,
    recordDigest: canonical.digest,
    attestation: canonical.attestation,
  };
  cert.checks.push(
    ...canonical.checks.map(
      (check): CertificationCheck => ({
        id: `contract.certification-core.${check.id.replaceAll("/", ".")}`,
        gate: "contract",
        status: check.ok ? "passed" : "failed",
        detail: check.detail ?? `${check.id} ${check.ok ? "passed" : "failed"}`,
      }),
    ),
  );
  if (canonical.status === "failed") cert.status = "failed";
  const targetChecks = targetCertificationChecks(files, air);
  cert.checks.push(...targetChecks);
  if (targetChecks.some((check) => check.status === "failed")) cert.status = "failed";
  writeFileSync(join(dir, CERTIFICATION_FILE), `${JSON.stringify(cert, null, 2)}\n`, "utf8");

  if (opts.json === true) {
    io.out(JSON.stringify(cert, null, 2));
  } else {
    io.out(renderCertificationSummary(cert, dir));
  }
  return cert.status === "passed" ? 0 : 1;
}

function targetCertificationChecks(
  files: Record<string, string>,
  air: ReturnType<typeof loadBundleAir>,
): CertificationCheck[] {
  const prefix = `targets/${GEMINI_ENTERPRISE_PROFILE.id}/`;
  if (!Object.keys(files).some((path) => path.startsWith(prefix))) return [];

  const result = verifyTargetKit(air, GEMINI_ENTERPRISE_PROFILE, files);
  return [
    {
      id: `contract.target-kit-exact.${GEMINI_ENTERPRISE_PROFILE.id}`,
      gate: "contract",
      status: result.ok ? "passed" : "failed",
      detail: result.ok
        ? `${GEMINI_ENTERPRISE_PROFILE.id} exactly regenerates from persisted setup config and canonical AIR (${result.expectedFiles.length} files, ${result.expectedDigest?.slice(0, 12)}…).`
        : result.findings.map((finding) => finding.detail).join("; "),
    },
  ];
}

/** The gate-by-gate summary `anvil certify` prints (details live behind --json). */
export function renderCertificationSummary(cert: Certification, dir: string): string {
  const lines: string[] = [];
  lines.push(
    `Static assurance — ${cert.serviceId}${cert.capabilityId ? ` (${cert.capabilityId})` : ""}  bundle ${cert.bundleHash.slice(0, 12)}…`,
  );
  const gates: CertificationGate[] = ["contract", "safety", "semantic", "runtime"];
  for (const gate of gates) {
    const checks = cert.checks.filter((c) => c.gate === gate);
    const failed = checks.filter((c) => c.status === "failed");
    const verdict = failed.length > 0 ? "FAIL" : "pass";
    lines.push(
      `  ${gate.padEnd(9)} ${verdict}  (${checks.length - failed.length}/${checks.length} checks)`,
    );
    for (const c of failed) lines.push(`    ✗ ${c.id}: ${c.detail}`);
  }
  lines.push("");
  lines.push(
    cert.status === "passed"
      ? `STATIC PASSED — wrote ${join(dir, CERTIFICATION_FILE)}. No generated surface was executed; continue with \`anvil selftest ${dir}\`, \`anvil conformance ${dir}\`, and \`anvil simulate ${dir}\` before preparing a release plan.`
      : `STATIC FAILED — wrote ${join(dir, CERTIFICATION_FILE)}. Fix the gates above and re-run static assurance.`,
  );
  return lines.join("\n");
}

/** Accept a bundle directory or a path to its air.yaml/air.json. */
export function resolveBundleDir(path: string): string {
  if (!existsSync(path)) throw new Error(`No such bundle: ${path}`);
  return statSync(path).isDirectory() ? path : dirname(path);
}

/** Load the canonical AIR from the already-read bundle files. */
export function loadBundleAir(dir: string, files: Record<string, string>) {
  const yaml = files["air.yaml"];
  if (yaml !== undefined) return airFromYaml(yaml);
  const json = files["air.json"];
  if (json !== undefined) return airFromJson(json);
  throw new Error(`No air.yaml or air.json in ${dir}. Run \`anvil compile\` first.`);
}
