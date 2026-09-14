import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { validate } from "@anvil/compiler";
import { generateBundle, installGeneratedBundle } from "@anvil/generators";
import { loadAir, type RepairCheckpoint, runRepairController } from "@anvil/refinement";
import type { Command } from "commander";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

export function registerRefineLoop(refine: Command, ctx: CommandContext): void {
  annotate(refine.command("loop"), { mutates: true })
    .summary("Run bounded autonomous semantic repair with fixed evals and replayable checkpoints.")
    .argument("<path>", "original generated bundle or AIR file; preserved")
    .requiredOption(
      "--out <dir>",
      "new controller output directory (checkpoint and regenerated bundle)",
    )
    .option("--resume", "revalidate checkpoint.json in the output directory before continuing")
    .option("--max-rounds <n>", "total round budget, including checkpoint history", "3")
    .option("--max-attempts <n>", "total investigation budget, including checkpoint history", "100")
    .option("--timeout-ms <n>", "time budget for this invocation", "60000")
    .option("--json", "print the controller checkpoint as JSON")
    .action(
      async (
        path: string,
        opts: {
          out: string;
          resume?: boolean;
          maxRounds: string;
          maxAttempts: string;
          timeoutMs: string;
          json?: boolean;
        },
      ) => {
        let lock: string | undefined;
        try {
          const air = loadAir(path);
          const out = resolve(opts.out);
          const checkpointPath = join(out, "checkpoint.json");
          if (!opts.resume && existsSync(out))
            throw new Error("Use a new output directory, or --resume with its original input");
          if (opts.resume && !existsSync(checkpointPath))
            throw new Error("No checkpoint.json to resume");
          mkdirSync(out, { recursive: true });
          const inside = relative(realpathSync(out), realpathSync(path));
          if (!inside || (!inside.startsWith("..") && !isAbsolute(inside)))
            throw new Error("Input must be outside the controller output directory");
          const lockPath = join(out, ".controller-lock");
          mkdirSync(lockPath);
          lock = lockPath;
          const baselineErrors = new Set(
            validate(air.operations)
              .diagnostics.filter((d) => d.level === "error")
              .map((d) => `${d.operationId}:${d.code}`),
          );
          const resume = opts.resume
            ? (JSON.parse(readFileSync(checkpointPath, "utf8")) as RepairCheckpoint)
            : undefined;
          const result = await runRepairController(air, {
            maxRounds: Number(opts.maxRounds),
            maxAttempts: Number(opts.maxAttempts),
            timeoutMs: Number(opts.timeoutMs),
            resume,
            evaluation: {
              id: "compiler-validation-v1",
              async evaluate(candidate) {
                const errors = validate(candidate.operations).diagnostics.filter(
                  (d) => d.level === "error",
                );
                return [
                  {
                    id: "compiler:no-new-errors",
                    passed: errors.every((d) => baselineErrors.has(`${d.operationId}:${d.code}`)),
                  },
                ];
              },
            },
            async checkpoint(state) {
              const temporary = `${checkpointPath}.tmp`;
              writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
              renameSync(temporary, checkpointPath);
            },
          });
          installGeneratedBundle(join(out, "bundle"), generateBundle(result.air), {
            onCleanupWarning: (message) => ctx.io.err(message),
          });
          const accepted = result.checkpoint.attempts.filter((a) => a.status === "accepted").length;
          ctx.io.out(
            opts.json
              ? JSON.stringify(
                  {
                    schemaVersion: 1,
                    reportType: "anvil.repair-controller",
                    ...result.checkpoint,
                    code: `repair/${result.checkpoint.stop}`,
                    message: `${accepted} repairs accepted; ${result.checkpoint.remainingDeficiencies} deficiencies remain.`,
                  },
                  null,
                  2,
                )
              : `${result.checkpoint.stop}: ${accepted} accepted; ${result.checkpoint.initialDeficiencies} → ${result.checkpoint.remainingDeficiencies} deficiencies. Bundle: ${join(out, "bundle")}.`,
          );
          ctx.code = result.checkpoint.stop === "complete" ? 0 : 2;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (opts.json)
            ctx.io.out(
              JSON.stringify({
                schemaVersion: 1,
                reportType: "anvil.repair-controller-error",
                code: "repair/failed",
                message,
              }),
            );
          else ctx.io.err(message);
          ctx.code = 1;
        } finally {
          if (lock) rmdirSync(lock);
        }
      },
    );
}
