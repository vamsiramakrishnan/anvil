import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { airFromJson, airFromYaml } from "@anvil/air";
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
 * `anvil certify <dir|air.yaml>` — run the certification gates over a generated
 * bundle and write `certification.json` into it. The judgement itself is the
 * pure `certifyBundle` core in @anvil/generators; this command is only the fs
 * shell and the summary printer. Exit 0 only when every gate passes.
 */
export function registerCertify(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("certify")
      .summary("Run the certification gates over a bundle and write certification.json.")
      .description(
        "Four deterministic gates judge the bundle as emitted: CONTRACT (AIR re-validates, generated surfaces align, and each persisted target subtree exactly regenerates from its setup config), SAFETY (risky mutations confirm, no retry without a proven basis or idempotency, coherent secret handling), SEMANTIC (approved operations are described, distinct, and routable by intent; blocking dispositions stop certification), and RUNTIME (mocks, evals, conformance test, and deploy artifacts are present and consistent). The certification binds to a content hash of the bundle, so any tamper invalidates it. Exit 0 only when every gate passes.",
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
    `Certification — ${cert.serviceId}${cert.capabilityId ? ` (${cert.capabilityId})` : ""}  bundle ${cert.bundleHash.slice(0, 12)}…`,
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
      ? `PASSED — wrote ${join(dir, CERTIFICATION_FILE)}. Publish with \`anvil publish ${dir} --target cloud-run\`.`
      : `FAILED — wrote ${join(dir, CERTIFICATION_FILE)}. Fix the gates above and re-certify.`,
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
