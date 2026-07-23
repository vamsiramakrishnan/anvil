import { join } from "node:path";
import { CapabilityBuildError, generateCapabilityBundle } from "@anvil/generators";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import { installGeneratedBundle } from "./bundle-transaction.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { loadAir } from "./shared.js";

/**
 * `anvil build <dir|air.yaml> <capability-id>` — compile ONE approved
 * capability into an aligned CLI + MCP + skill bundle. The heavy lifting is
 * `generateCapabilityBundle` (@anvil/generators): narrow the document to the
 * capability's approved operations and reachable schemas, reuse the ordinary
 * whole-service generator, and stamp a content-addressed `bundle.json`.
 *
 * Refusals are structured, not silent: a missing / unapproved / empty
 * capability exits non-zero with a typed error code.
 */
export function registerBuild(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("build")
      .summary("Compile one approved capability into an aligned CLI + MCP + skill bundle.")
      .description(
        "Narrows the AIR document to the capability's approved operations and reachable schemas, then reuses the whole-service generator, so the capability bundle is the same aligned projection of a smaller model. Refuses (with a structured error) a capability that is missing, not lifecycle-approved, or would build empty. Stamps a content-addressed bundle.json (capabilityHash + contractHash shared by every surface); rebuilding unchanged input reproduces identical hashes.",
      )
      .argument("<path>", "generated bundle directory or air.yaml")
      .argument("<capability-id>", "an approved capability id")
      .option("--out <dir>", "bundle output directory (default generated/<capability-id>)")
      .option("--endpoint <url>", "MCP endpoint recorded in the generated artifacts")
      .action((path: string, capabilityId: string, opts: BuildOptions) => {
        ctx.code = runBuild(path, capabilityId, opts, ctx.io);
      }),
    { mutates: true },
  );
}

interface BuildOptions {
  out?: string;
  endpoint?: string;
}

function runBuild(path: string, capabilityId: string, opts: BuildOptions, io: CliIO): number {
  const air = loadAir(path);
  let built: ReturnType<typeof generateCapabilityBundle>;
  try {
    built = generateCapabilityBundle(air, capabilityId, { mcpEndpoint: opts.endpoint });
  } catch (err) {
    if (err instanceof CapabilityBuildError) {
      io.err(`error ${err.code}: ${err.message}`);
      return 1;
    }
    throw err;
  }

  const outDir = opts.out ?? join("generated", capabilityId);
  const written = installGeneratedBundle(outDir, built.bundle, {
    onCleanupWarning: (message) => io.err(`Warning: ${message}`),
  });
  const { manifest, view } = built;
  io.out(
    `Built capability ${capabilityId} @ ${manifest.capabilityVersion} → ${outDir} (${written.length} files).`,
  );
  io.out(`  operations: ${view.operations.length} approved · workflows: ${view.workflows.length}`);
  io.out(`  contractHash: ${manifest.contractHash.slice(0, 16)}… (cli = mcp = skill)`);
  io.out(`  manifest: ${join(outDir, "bundle.json")}`);
  return 0;
}
