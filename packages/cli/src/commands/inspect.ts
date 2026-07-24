import { exampleInput, operationCatalog } from "@anvil/generators";
import { cliFlagsFor } from "@anvil/harness";
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
  const catalog = operationCatalog(air);
  if (opts.json === true) {
    io.out(JSON.stringify(catalog, null, 2));
    return 0;
  }
  io.out(
    `${air.service.displayName ?? air.service.id} @ ${air.service.version} — ${air.operations.length} operations`,
  );
  io.out("");
  for (const op of catalog.operations) {
    const operation = air.operations.find((candidate) => candidate.id === op.id);
    if (!operation) throw new Error(`Catalog operation '${op.id}' is missing from AIR.`);
    const example = exampleInput(operation);
    const invocation = op.cli.split(/\s+/).slice(1);
    const safeArgs = cliFlagsFor(operation, example);
    if (example.confirm === true) safeArgs.push("--confirm");
    safeArgs.push("--dry-run");
    const safeCommand = [
      "anvil",
      "run",
      shellQuote(path),
      ...invocation.map(shellWord),
      ...safeArgs.map(shellWord),
    ].join(" ");
    const effect =
      op.effect === "mutation"
        ? `mutation · ${op.risk} risk · ${op.reversible ? "reversible" : "irreversible"}`
        : `read · ${op.risk} risk`;
    const confirmation = op.confirmationRequired
      ? op.humanApproval
        ? "human required"
        : "required"
      : "not required";
    const retry = op.retrySafe ? "safe by contract" : "not automatic";
    const scopes = op.auth.scopes.length > 0 ? op.auth.scopes.join(", ") : "none declared";

    io.out(`  ${op.displayName} · ${op.state} · id=${op.id}`);
    io.out(`    command       ${op.cli}`);
    io.out(`    try safely    ${safeCommand}`);
    io.out(`    effect        ${effect}`);
    io.out(
      `    safeguards    confirm ${confirmation} · idempotency ${op.idempotency} · retry ${retry}`,
    );
    io.out(`    access        ${op.auth.type} · ${op.principal} principal · scopes ${scopes}`);
    io.out("");
  }
  return 0;
}

/** POSIX-shell quoting for a bundle coordinate, which may contain whitespace or metacharacters. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/** Keep simple generated flags readable; quote every value that the shell could reinterpret. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:@%+,=-]+$/.test(value) ? value : shellQuote(value);
}
