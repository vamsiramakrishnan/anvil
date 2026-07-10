import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { airFromJson, airFromYaml } from "@anvil/air";
import {
  CERTIFICATION_FILE,
  type Certification,
  type CertificationGate,
  type Clock,
  certifyBundle,
  readBundleDir,
} from "@anvil/generators";
import type { CliIO } from "./io.js";

/**
 * `anvil certify <dir|air.yaml>` — run the certification gates over a generated
 * bundle and write `certification.json` into it. The judgement itself is the
 * pure `certifyBundle` core in @anvil/generators; this command is only the fs
 * shell and the summary printer. Exit 0 only when every gate passes.
 */
export function cmdCertify(
  args: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
  deps: { now?: Clock } = {},
): number {
  const path = args[0];
  if (!path) {
    io.err("Usage: anvil certify <dir|air.yaml> [--json]");
    return 1;
  }
  const dir = resolveBundleDir(path);
  const files = readBundleDir(dir);
  const air = loadBundleAir(dir, files);

  const cert = certifyBundle(files, air, { now: deps.now });
  writeFileSync(join(dir, CERTIFICATION_FILE), `${JSON.stringify(cert, null, 2)}\n`, "utf8");

  if (flags.json === true) {
    io.out(JSON.stringify(cert, null, 2));
  } else {
    io.out(renderCertificationSummary(cert, dir));
  }
  return cert.status === "passed" ? 0 : 1;
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
