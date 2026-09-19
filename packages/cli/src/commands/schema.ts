import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { manifestJsonSchema } from "@anvil/compiler";
import type { Command } from "commander";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil schema manifest [--out <file>]` — the JSON Schema for `anvil.yaml`,
 * derived from the exact zod schema `anvil compile` parses the manifest with.
 * Point a YAML language server at the emitted file for completion and
 * validation while authoring; the compiler remains the authority on
 * cross-field rules the schema cannot express.
 */
export function registerSchema(parent: Command, ctx: CommandContext): void {
  const schema = annotate(
    parent
      .command("schema")
      .summary("Emit the JSON Schema for files a reviewer hand-writes.")
      .description(
        "Prints machine-readable schemas derived from the same definitions the compiler validates with, for editor completion and validation.",
      ),
    { mutates: false },
  );

  schema
    .command("manifest")
    .summary("The JSON Schema for the anvil.yaml manifest.")
    .description(
      "Emits draft 2020-12 JSON Schema for the manifest (`--manifest` to `anvil compile`). " +
        "Add `# yaml-language-server: $schema=<path>` as the first line of a manifest to get completion and validation in an editor. " +
        "Keys are strict: an unknown key is a compile error, and this schema says which keys exist.",
    )
    .option("--out <file>", "write the schema to a file instead of stdout")
    .action((opts: { out?: string }) => {
      const text = `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`;
      if (opts.out) {
        mkdirSync(dirname(opts.out), { recursive: true });
        writeFileSync(opts.out, text, "utf8");
        ctx.io.err(`Wrote ${opts.out}`);
      } else {
        ctx.io.out(text.trimEnd());
      }
      ctx.code = 0;
    });
}
