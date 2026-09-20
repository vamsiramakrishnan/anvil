import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AirDocument } from "@anvil/air";
import { certify as certifyContractAir } from "@anvil/certification";
import {
  CERTIFICATION_FILE,
  type Certification,
  type CertificationCheck,
  type CertificationGate,
  type Clock,
  certifyBundle,
  loadBundleAir,
  readBundleDir,
  resolveBundleDir,
} from "@anvil/generators";
import { listProfiles, verifyTargetKit } from "@anvil/targets";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil certify <dir|air.yaml>` — run the bundle-assurance gates over a
 * generated bundle and write `certification.json` into it.
 *
 * By default this is static: the four generated-byte gates plus the canonical
 * engine's static checks, proving byte/contract coherence without booting
 * anything. With `--executable` the canonical engine (`@anvil/certification`,
 * ADR-0018) additionally boots the contract-faithful simulator, exercises the
 * live surface (confirmation refusal, scope enforcement, idempotent replay,
 * response shape, fault normalization) and runs the mutation battery, reaching
 * `simulator_exercised` or `certified`. The generated MCP/CLI surfaces are
 * still not booted here — `selftest` and `conformance` do that.
 */
export function registerCertify(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("certify")
      .summary("Run bundle-assurance gates (static, or --executable) and write certification.json.")
      .description(
        "Static assurance by default: four deterministic gates judge the bundle as emitted. CONTRACT re-validates AIR, generated-surface alignment, and persisted target-kit regeneration; SAFETY checks confirmation, retry/idempotency, and secret handling; SEMANTIC checks descriptions and routing; RUNTIME checks generated mocks, evals, conformance tests, and deploy artifacts. The record binds to a content hash, so generated-byte tampering invalidates it. " +
          "With --executable the canonical certification engine also boots the contract-faithful simulator and exercises it (confirmation refusal, scope enforcement, idempotent replay, response shape, fault normalization), then runs the mutation battery — each weakened contract is booted and a check must fail against it — and records the engine's status in certification.json under assurance.engineStatus: `certified` when an applicable safety mutant was killed, `simulator_exercised` when the surface carried nothing safety-sensitive to weaken. " +
          "Neither mode boots the generated MCP/CLI surfaces; use `anvil selftest` and `anvil conformance` for that evidence.",
      )
      .argument("<path>", "bundle directory or its air.yaml")
      .option(
        "--executable",
        "boot the simulator, exercise the surface, and run the mutation battery (assurance.level executable)",
      )
      .option("--json", "emit the full certification as JSON")
      .action((path: string, opts: CertifyOptions) => {
        ctx.code = runCertify(path, opts, ctx.io);
      }),
    { mutates: true },
  );
}

export interface CertifyOptions {
  json?: boolean;
  executable?: boolean;
}

/** The engine statuses each mode may legitimately produce; anything else is a defect. */
const STATIC_STATUSES = new Set(["failed", "static_passed"]);
const EXECUTABLE_STATUSES = new Set([
  "failed",
  "static_passed",
  "simulator_exercised",
  "certified",
]);

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
  const executable = opts.executable === true;

  const cert = certifyBundle(files, air, { now: deps.now });
  // Bridge the generated-byte judgement to the canonical certification
  // attestation model. Static unless --executable asked the engine to boot the
  // simulator; the level recorded is the phase that actually ran.
  const canonical = certifyContractAir(air, { executable, seed: 1 });
  const allowed = executable ? EXECUTABLE_STATUSES : STATIC_STATUSES;
  if (!allowed.has(canonical.status)) {
    throw new Error(
      `${executable ? "Executable" : "Static"} assurance returned unexpected status "${canonical.status}".`,
    );
  }
  cert.assurance = {
    level: executable ? "executable" : "static",
    engine: "@anvil/certification",
    // Narrowed by the allowed-set guard above; `expired` is never minted here.
    engineStatus: canonical.status as Exclude<typeof canonical.status, "expired">,
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

/**
 * One drift check per registered profile whose target subtree is present in
 * the bundle — checked exactly the way Gemini Enterprise's kit always was,
 * generalized over `listProfiles()` instead of one hardcoded profile.
 */
function targetCertificationChecks(
  files: Record<string, string>,
  air: AirDocument,
): CertificationCheck[] {
  const checks: CertificationCheck[] = [];
  for (const profile of listProfiles()) {
    const prefix = `targets/${profile.id}/`;
    if (!Object.keys(files).some((path) => path.startsWith(prefix))) continue;

    const result = verifyTargetKit(air, profile, files);
    checks.push({
      id: `contract.target-kit-exact.${profile.id}`,
      gate: "contract",
      status: result.ok ? "passed" : "failed",
      detail: result.ok
        ? `${profile.id} exactly regenerates from persisted setup config and canonical AIR (${result.expectedFiles.length} files, ${result.expectedDigest?.slice(0, 12)}…).`
        : result.findings.map((finding) => finding.detail).join("; "),
    });
  }
  return checks;
}

/** The gate-by-gate summary `anvil certify` prints (details live behind --json). */
function renderCertificationSummary(cert: Certification, dir: string): string {
  const executable = cert.assurance?.level === "executable";
  const lines: string[] = [];
  lines.push(
    `${executable ? "Executable" : "Static"} assurance — ${cert.serviceId}${cert.capabilityId ? ` (${cert.capabilityId})` : ""}  bundle ${cert.bundleHash.slice(0, 12)}…`,
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
  const record = join(dir, CERTIFICATION_FILE);
  if (cert.status !== "passed") {
    lines.push(
      `${executable ? "EXECUTABLE" : "STATIC"} FAILED — wrote ${record}. Fix the gates above and re-run.`,
    );
  } else if (!executable) {
    lines.push(
      `STATIC PASSED — wrote ${record}. No generated surface was executed; continue with \`anvil certify --executable ${dir}\`, \`anvil selftest ${dir}\`, \`anvil conformance ${dir}\`, and \`anvil simulate ${dir}\` before preparing a release plan.`,
    );
  } else {
    const mutants = cert.checks.filter((c) =>
      c.id.startsWith("contract.certification-core.mutation."),
    );
    const killed = mutants.filter((c) => c.detail.startsWith("killed by")).length;
    const applicable = mutants.filter((c) => !c.detail.startsWith("inapplicable")).length;
    const status = cert.assurance?.engineStatus;
    lines.push(
      status === "certified"
        ? `CERTIFIED — wrote ${record}. The simulator was booted and exercised; ${killed}/${applicable} applicable mutants killed, each by a named check.`
        : `SIMULATOR EXERCISED — wrote ${record}. The simulator was booted and exercised, but no safety mutant was applicable (${applicable} applicable), so no safety-regression claim is proven.`,
    );
    lines.push(
      `The generated MCP/CLI surfaces were not booted; continue with \`anvil selftest ${dir}\` and \`anvil conformance ${dir}\`.`,
    );
  }
  return lines.join("\n");
}
