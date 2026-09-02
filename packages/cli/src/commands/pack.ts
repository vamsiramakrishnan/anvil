import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { contractHash } from "@anvil/air";
import {
  bundleHash,
  isDerivedRecordFile,
  loadBundleAir,
  readBundleDir,
  resolveBundleDir,
} from "@anvil/generators";
import {
  type AgentSystemPack,
  archivePack,
  assembleSystemPack,
  contentDigest,
  type PackArtifactKind,
  readArchive,
  verifyPack,
} from "@anvil/system-pack";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import { VERSION } from "../program.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil pack` — the distribution seam.
 *
 * A compiled bundle is a directory only its builder trusts. A *pack* is the
 * same content as one content-addressed artifact: every file digested, the
 * digests digested, the certification status carried on the envelope — so a
 * pack can cross a machine boundary and the receiver can prove, before a
 * single file lands on disk, that what arrived is exactly what was certified.
 * That proof is what makes a registry of compiled toolchains possible at all;
 * this command is deliberately transport-agnostic (a file, an artifact store,
 * an HTTPS URL) because identity lives in the bytes, not the channel.
 *
 * `install` is where the trust posture bites: verification failures refuse,
 * an uncertified pack refuses unless the operator says otherwise in words,
 * and unpacking is staged-then-renamed so an interrupted install leaves
 * either nothing or everything, never a mixture.
 */
export function registerPack(parent: Command, ctx: CommandContext): void {
  const pack = parent
    .command("pack")
    .summary("Build, verify, and install content-addressed system packs.");

  annotate(
    pack
      .command("build")
      .summary("Assemble a bundle into one verifiable, content-addressed pack file.")
      .description(
        "Reads a generated bundle and assembles it into an Agent System Pack: every generated file " +
          "becomes a digested artifact, the artifact manifest and pack digests are computed over the " +
          "content, and the bundle's certification status (certification.json, when present) is " +
          "carried on the pack envelope. Derived records (*.report.json and other evidence files) " +
          "stay out, exactly as they stay out of the bundle's identity hash. The output is one " +
          "deterministic file: the same bundle always packs to byte-identical output.",
      )
      .argument("<dir>", "generated bundle directory")
      .option("--out <file>", "where to write the pack (default: <dir>/system.pack.json)")
      .action(async (dir: string, opts: { out?: string }) => {
        ctx.code = runPackBuild(dir, opts, ctx.io);
      }),
    { mutates: true },
  );

  annotate(
    pack
      .command("verify")
      .summary("Recompute every digest in a pack file and report what diverged.")
      .description(
        "Reads a pack file and verifies it end to end: envelope entries re-hash against their " +
          "claimed digests, every artifact's content re-hashes against the manifest, and the " +
          "manifest and pack digests recompute. Failures are reported one per line — a verify " +
          "that cannot say what diverged is just a slower way of being wrong.",
      )
      .argument("<file>", "pack file to verify")
      .action(async (file: string) => {
        ctx.code = runPackVerify(file, ctx.io);
      }),
    { mutates: false },
  );

  annotate(
    pack
      .command("install")
      .summary("Verify a pack — digests and certification — then unpack it, transactionally.")
      .description(
        "Fetches a pack from a local path or an https:// URL, verifies every content digest, the " +
          "artifact manifest digest, and the pack digest, and checks the pack carries a " +
          "certification with status 'certified' — all BEFORE a single file lands at the target. " +
          "An uncertified or failed-certification pack refuses unless --allow-uncertified states " +
          "the operator's intent in so many words. Unpacking stages into a temporary directory and " +
          "renames it in, so an interrupted install leaves either nothing or a complete bundle. " +
          "Refuses to overwrite an existing target.",
      )
      .argument("<source>", "pack file path, or an https:// URL")
      .requiredOption("--out <dir>", "directory to install the bundle into (must not exist)")
      .option(
        "--allow-uncertified",
        "install even when the pack carries no 'certified' certification (recorded in the output)",
      )
      .action(async (source: string, opts: { out: string; allowUncertified?: boolean }) => {
        ctx.code = await runPackInstall(source, opts, ctx.io);
      }),
    { mutates: true },
  );
}

/** Where in the bundle tree a file lives decides what kind of artifact it is. */
function artifactKind(path: string): PackArtifactKind {
  if (path === "air.json" || path === "air.yaml") return "contract";
  if (path.startsWith("mcp/")) return "mcp";
  if (path.startsWith("cli/")) return "cli";
  if (path.startsWith("skill/") || path.startsWith("skills/")) return "skill";
  if (path.startsWith("mock/") || path.startsWith("simulator/")) return "simulator";
  if (path.endsWith(".md")) return "doc";
  return "other";
}

const CERTIFIED_STATUSES = new Set([
  "failed",
  "static_passed",
  "simulator_exercised",
  "certified",
  "expired",
]);

type PackCertification = NonNullable<AgentSystemPack["certification"]>;

function certificationRefOf(dir: string): PackCertification | undefined {
  const file = join(dir, "certification.json");
  if (!existsSync(file)) return undefined;
  const bytes = readFileSync(file);
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as { status?: unknown };
    if (typeof parsed.status !== "string" || !CERTIFIED_STATUSES.has(parsed.status)) {
      return undefined;
    }
    return {
      status: parsed.status as PackCertification["status"],
      digest: contentDigest(bytes),
    };
  } catch {
    return undefined;
  }
}

export function runPackBuild(path: string, opts: { out?: string }, io: CliIO): number {
  const dir = resolveBundleDir(path);
  const files = readBundleDir(dir);
  const air = loadBundleAir(dir, files);
  const encoder = new TextEncoder();

  const contractDigest = contractHash(air);
  const artifacts = Object.keys(files)
    .filter((rel) => !isDerivedRecordFile(rel) && rel !== "system.pack.json")
    .sort()
    .map((rel) => ({
      id: rel,
      kind: artifactKind(rel),
      path: rel,
      bytes: encoder.encode(files[rel] ?? ""),
      build: {
        // Every generated file is a function of the contract and the generator
        // version — stated as such, so `explainRebuild` can answer "what must
        // regenerate if the contract changes" with "everything", truthfully.
        inputDigests: [contractDigest],
        implementationVersion: `anvil@${VERSION}`,
        configurationDigest: contentDigest(new Uint8Array(0)),
      },
    }));

  const certification = certificationRefOf(dir);
  const assembled = assembleSystemPack({
    version: air.service.version,
    contractRef: { id: air.service.id, digest: contractDigest },
    artifacts,
    ...(certification ? { certification } : {}),
  });
  const archive = archivePack(assembled.pack, assembled.contents);

  const out = resolve(opts.out ?? join(dir, "system.pack.json"));
  writeFileSync(out, archive.bytes);
  io.out(
    `Packed ${artifacts.length} artifact(s) from ${dir} (bundle ${bundleHash(files).slice(0, 12)}…).`,
  );
  io.out(`Pack ${assembled.pack.id} digest ${assembled.pack.digest.slice(0, 12)}…`);
  io.out(
    certification
      ? `Certification: ${String(certification.status)} (digest ${certification.digest.slice(0, 12)}…).`
      : "Certification: none found — `anvil pack install` will refuse this pack without --allow-uncertified.",
  );
  io.out(`Wrote ${out} (archive digest ${archive.digest.slice(0, 12)}…).`);
  return 0;
}

export function runPackVerify(file: string, io: CliIO): number {
  const bytes = readFileSync(resolve(file));
  let pack: AgentSystemPack;
  let contents: Map<string, Uint8Array>;
  try {
    ({ pack, contents } = readArchive(bytes));
  } catch (error) {
    io.out(`REFUSED: ${error instanceof Error ? error.message : "unreadable archive"}`);
    return 1;
  }
  const verdict = verifyPack(pack, contents);
  if (!verdict.ok) {
    io.out(`FAILED — ${verdict.findings.length} finding(s):`);
    for (const finding of verdict.findings) {
      io.out(`  - [${finding.code}] ${finding.message}`);
    }
    return 1;
  }
  io.out(
    `OK — pack ${pack.id} (${pack.artifacts.artifacts.length} artifact(s), ` +
      `digest ${pack.digest.slice(0, 12)}…) verified end to end.`,
  );
  return 0;
}

const MAX_REMOTE_PACK_BYTES = 64 * 1024 * 1024;

async function fetchPackBytes(source: string): Promise<Uint8Array> {
  if (source.startsWith("http://")) {
    throw new Error(
      "Refusing to fetch a pack over plain http: content addressing proves integrity, not confidentiality or origin.",
    );
  }
  if (source.startsWith("https://")) {
    const response = await fetch(source, { redirect: "error" });
    if (!response.ok) {
      throw new Error(`The pack source answered HTTP ${response.status}.`);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_REMOTE_PACK_BYTES) {
      throw new Error(
        `The pack is ${buffer.byteLength} bytes; the remote-fetch ceiling is ${MAX_REMOTE_PACK_BYTES}.`,
      );
    }
    return new Uint8Array(buffer);
  }
  return readFileSync(resolve(source));
}

export async function runPackInstall(
  source: string,
  opts: { out: string; allowUncertified?: boolean },
  io: CliIO,
): Promise<number> {
  const out = resolve(opts.out);
  if (existsSync(out)) {
    io.out(`REFUSED: ${out} already exists. Installs never overwrite; remove it first.`);
    return 1;
  }

  let bytes: Uint8Array;
  try {
    bytes = await fetchPackBytes(source);
  } catch (error) {
    io.out(`REFUSED: ${error instanceof Error ? error.message : "the pack could not be fetched"}`);
    return 1;
  }

  let pack: AgentSystemPack;
  let contents: Map<string, Uint8Array>;
  try {
    ({ pack, contents } = readArchive(bytes));
  } catch (error) {
    io.out(`REFUSED: ${error instanceof Error ? error.message : "unreadable archive"}`);
    return 1;
  }

  const verdict = verifyPack(pack, contents);
  if (!verdict.ok) {
    io.out(`REFUSED — the pack does not verify (${verdict.findings.length} finding(s)):`);
    for (const finding of verdict.findings.slice(0, 12)) {
      io.out(`  - [${finding.code}] ${finding.message}`);
    }
    return 1;
  }

  // The certification gate. Digests prove the bytes are the builder's bytes;
  // the certification says whether those bytes ever passed the gates. Both
  // questions matter, and only the operator may waive the second one.
  const status = pack.certification?.status;
  if (status !== "certified" && opts.allowUncertified !== true) {
    io.out(
      `REFUSED: this pack's certification status is ${status ? `'${status}'` : "absent"}, not 'certified'. ` +
        "Pass --allow-uncertified to install it anyway, with that fact recorded here in your terminal.",
    );
    return 1;
  }

  // Stage-then-rename: same-filesystem staging beside the target, so the
  // rename is atomic and an interrupted install leaves nothing at `out`.
  mkdirSync(dirname(out), { recursive: true });
  const staging = `${out}.staging-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(staging, { recursive: true });
    for (const [rel, fileBytes] of contents) {
      const target = join(staging, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, fileBytes);
    }
    renameSync(staging, out);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    io.out(
      `REFUSED: install failed mid-stage and was rolled back: ${error instanceof Error ? error.message : "unknown error"}.`,
    );
    return 1;
  }

  io.out(
    `Installed pack ${pack.id} (${pack.artifacts.artifacts.length} artifact(s), ` +
      `digest ${pack.digest.slice(0, 12)}…) to ${out}.`,
  );
  io.out(
    status === "certified"
      ? "Certification: certified — verified before anything touched disk."
      : `Certification: ${status ?? "absent"} — installed with --allow-uncertified.`,
  );
  return 0;
}
