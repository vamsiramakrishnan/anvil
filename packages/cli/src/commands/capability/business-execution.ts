import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FileBusinessJournal, reconcileBusinessExecution } from "@anvil/runtime";
import type { Command } from "commander";
import type { CommandContext } from "../context.js";
import { annotate } from "../meta.js";
export function registerBusinessExecution(parent: Command, ctx: CommandContext): void {
  const execution = annotate(
    parent
      .command("execution")
      .summary("Inspect durable business execution journals and reconcile attempted effects."),
    { mutates: false },
  );
  annotate(
    execution
      .command("inspect")
      .argument("<journal>")
      .argument("<trace>")
      .summary("Read a private execution journal and verify its integrity chain."),
    { mutates: false },
  ).action(async (dir: string, trace: string) => {
    try {
      ctx.io.out(JSON.stringify(await new FileBusinessJournal(resolve(dir)).read(trace), null, 2));
    } catch (e) {
      ctx.io.err(e instanceof Error ? e.message : String(e));
      ctx.code = 1;
    }
  });
  annotate(
    execution
      .command("reconcile")
      .argument("<journal>")
      .argument("<trace>")
      .requiredOption("--expected <digest>", "latest inspected journal record digest")
      .requiredOption("--reviewer <name>", "accountable reviewer")
      .requiredOption("--note <text>", "reconciliation rationale")
      .requiredOption(
        "--verifier <module>",
        "trusted broker module: default async verify(records) returns authoritative receipt evidence",
      )
      .summary(
        "Record verified backend outcomes without replaying writes or clearing intent reservations.",
      ),
    { mutates: true },
  ).action(
    async (
      dir: string,
      trace: string,
      opts: { expected: string; reviewer: string; note: string; verifier: string },
    ) => {
      try {
        const module = await import(pathToFileURL(resolve(opts.verifier)).href);
        if (typeof module.default !== "function")
          throw new Error(
            "Verifier must default-export an authoritative receipt verification function.",
          );
        ctx.io.out(
          JSON.stringify(
            await reconcileBusinessExecution({
              journal: new FileBusinessJournal(resolve(dir)),
              trace,
              expectedDigest: opts.expected,
              reviewer: opts.reviewer,
              note: opts.note,
              verify: module.default,
            }),
            null,
            2,
          ),
        );
      } catch (e) {
        ctx.io.err(e instanceof Error ? e.message : String(e));
        ctx.code = 1;
      }
    },
  );
}
