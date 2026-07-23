import { operationCatalog } from "@anvil/generators";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { loadAir } from "./shared.js";

/** `anvil inspect <dir|air.yaml>` — the operation catalog and safety posture. */
export function registerInspect(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("inspect")
      .summary("Show the operation catalog and each operation's safety posture.")
      .description(
        "Read-only. Use before approving to see effect, risk, idempotency, retry-safety, and state.",
      )
      .argument("<path>", "generated bundle directory or air.yaml")
      .option("--json", "emit the operation catalog as JSON")
      .action((path: string, opts: { json?: boolean }) => {
        ctx.code = runInspect(path, opts, ctx.io);
      }),
    { mutates: false },
  );
}

function runInspect(path: string, opts: { json?: boolean }, io: CliIO): number {
  const air = loadAir(path);
  if (opts.json === true) {
    io.out(JSON.stringify(operationCatalog(air), null, 2));
    return 0;
  }
  io.out(
    `${air.service.displayName ?? air.service.id} @ ${air.service.version} — ${air.operations.length} operations`,
  );
  for (const op of air.operations) {
    const tag = op.effect.kind === "mutation" ? `mutation/${op.effect.risk}` : "read";
    io.out(
      `  ${op.cli.command.padEnd(34)} ${tag.padEnd(18)} ${op.state}${op.confirmation.required ? " ⚠" : ""}  id=${op.id}`,
    );
  }
  return 0;
}
