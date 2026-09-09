import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileBusiness } from "@anvil/compiler";
import {
  generateBundle,
  readBundleDir,
  resourceOptionsFromGenerationMetadata,
  writeBundle,
} from "@anvil/generators";
import { loadAir } from "@anvil/refinement";
import type { Command } from "commander";
import { parse } from "yaml";
import { emitRefusal } from "../../envelope.js";
import type { CommandContext } from "../context.js";
import { annotate } from "../meta.js";

export function registerCapabilityCompile(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("compile")
      .summary("Compile a business contract into aligned MCP, CLI, skill, and four SDKs.")
      .description(
        "Compile explicit business inputs, outcomes, source authority, bindings, effects, and recovery against approved source AIR snapshots. The default state is proposed. Review the definition before marking actions approved. Public artifacts contain business actions; the private execution plan stays in runtime and generator inputs. The output must be a new directory.",
      )
      .argument("<definition>", "business definition YAML or JSON")
      .requiredOption(
        "--source <binding...>",
        "source bindings, each alias=bundle-directory-or-air-file",
      )
      .requiredOption("--out <directory>", "new generated business bundle directory")
      .option("--json", "emit the business surface summary as JSON"),
    { mutates: true },
  ).action((definition: string, opts: { source: string[]; out: string; json?: boolean }) => {
    try {
      if (existsSync(resolve(opts.out)))
        throw new Error("Output exists; use a new directory to preserve the reviewed bundle.");
      const sources: Record<string, unknown> = {};
      for (const binding of opts.source) {
        const index = binding.indexOf("=");
        const alias = binding.slice(0, index);
        if (index < 1 || !/^[a-z][a-z0-9_]{0,63}$/.test(alias) || Object.hasOwn(sources, alias))
          throw new Error("Use distinct source bindings in alias=path form.");
        sources[alias] = loadAir(resolve(binding.slice(index + 1)));
      }
      const { air, plan } = compileBusiness(
        parse(readFileSync(resolve(definition), "utf8")),
        sources,
      );
      const bundle = generateBundle(air, { businessPlan: plan });
      writeBundle(resolve(opts.out), bundle);
      ctx.io.out(
        opts.json
          ? JSON.stringify(
              {
                schemaVersion: 1,
                reportType: "anvil.business-compile",
                service: air.service.id,
                business: air.business,
                output: resolve(opts.out),
              },
              null,
              2,
            )
          : `Compiled ${air.operations.length} business action(s) into ${resolve(opts.out)}.\nInspect the agent view with anvil capability preview ${opts.out}; add --execution for the private plan.\nConfigure verified identity, source grants, and the execution ledger before starting runtime/server.js.`,
      );
    } catch (error) {
      ctx.code = emitRefusal(ctx.io, opts.json, {
        reportType: "anvil.business-compile-error",
        code: "business_compile_refused",
        message: error instanceof Error ? error.message : "Business compilation failed.",
      });
    }
  });

  annotate(
    parent
      .command("preview")
      .summary("Preview the business surface or inspect its private execution plan.")
      .description(
        "The default view shows agent inputs, outcomes, intent guidance, and effects. --execution shows operator-only source bindings, authority, preconditions, and recovery. This command never executes operations or grants approval.",
      )
      .argument("<bundle>", "compiled business bundle directory")
      .option("--execution", "show the private operator execution view"),
    { mutates: false },
  ).action((path: string, opts: { execution?: boolean }) => {
    try {
      const air = loadAir(path);
      if (!air.business) throw new Error("This bundle has no business contract.");
      if (opts.execution) {
        const files = readBundleDir(path);
        const plan = resourceOptionsFromGenerationMetadata(files["generation.json"])?.businessPlan;
        if (!plan || plan.digest !== air.business.planDigest)
          throw new Error("Private plan is missing or does not match the public contract.");
        ctx.io.out(
          JSON.stringify(
            {
              planDigest: plan.digest,
              actions: plan.definition.actions.map((a) => ({
                id: a.id,
                state: a.state,
                steps: a.steps,
              })),
            },
            null,
            2,
          ),
        );
      } else {
        ctx.io.out(
          JSON.stringify(
            {
              ...air.business,
              operations: air.operations
                .filter((op) => op.state === "approved")
                .map((op) => ({
                  name: op.mcp.toolName,
                  description: op.description,
                  input: op.input.body?.schema,
                  output: op.output.schema,
                })),
            },
            null,
            2,
          ),
        );
      }
    } catch (error) {
      ctx.io.err(error instanceof Error ? error.message : "Business preview failed.");
      ctx.code = 1;
    }
  });
}
