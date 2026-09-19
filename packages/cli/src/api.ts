import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AirDocument, Diagnostic } from "@anvil/air";
import {
  type CompilerSource,
  compileSource,
  formatManifestIssue,
  type HumanApprovalPolicy,
  type ManifestIssue,
  parseManifestDetailed,
  type SourceDiagnostic,
} from "@anvil/compiler";
import { generateBundle, installGeneratedBundle } from "@anvil/generators";
import { sourceService } from "./commands/source.js";

/**
 * Anvil as a library: the one call `anvil compile` makes, exposed so a build
 * script, a test, or another tool gets byte-identical output to the CLI —
 * lock the source, parse the manifest, compile AIR, generate the bundle,
 * install it. The command is a thin flag-parser over this function, so the
 * two cannot drift.
 *
 *   import { compileBundle } from "@anvil/cli";
 *   const result = await compileBundle({ spec: "openapi.yaml", manifest: "anvil.yaml", out: "generated/payments" });
 *   if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
 */
export interface CompileBundleOptions {
  /** A spec file to import and lock, or `source` for an already-locked snapshot. */
  spec?: string;
  /** An already-locked snapshot id (see `anvil source add`). */
  source?: string;
  /** Snapshot-relative entrypoint when a source has several. */
  entrypoint?: string;
  /** Path to the manifest file, or its text (`manifestText`). */
  manifest?: string;
  manifestText?: string;
  serviceId?: string;
  /** Bundle output directory. Defaults to `generated/<service-id>`. */
  out?: string;
  /** MCP endpoint recorded in the generated artifacts. */
  endpoint?: string;
  humanApproval?: HumanApprovalPolicy;
  /** Workspace root holding `.anvil/sources`. Defaults to the current directory. */
  root?: string;
  /** Receives non-fatal warnings (a stale file cleaned from the output directory). */
  onWarning?: (message: string) => void;
}

export type CompileBundleResult =
  | {
      ok: true;
      air: AirDocument;
      snapshotId: string;
      outDir: string;
      /** Files written under `outDir`. */
      written: string[];
      diagnostics: Diagnostic[];
    }
  | {
      ok: false;
      /** Why nothing was written: the source could not be locked or read, or the manifest is invalid. */
      stage: "source" | "manifest";
      diagnostics: Array<Diagnostic | SourceDiagnostic>;
      /** Present for a manifest failure: each issue located in the YAML. */
      manifestIssues?: ManifestIssue[];
    };

export async function compileBundle(options: CompileBundleOptions): Promise<CompileBundleResult> {
  const service = sourceService({ root: options.root });
  let resolved: { source?: CompilerSource; diagnostics: SourceDiagnostic[] };
  if (options.source !== undefined) {
    if (options.spec !== undefined) {
      return fail(
        "source",
        "source/conflicting_input",
        "Pass either `spec` or `source`, not both.",
      );
    }
    resolved = await service.compilerSource(options.source, options.entrypoint);
  } else if (options.spec === undefined) {
    return fail(
      "source",
      "source/no_input",
      "Provide `spec` (a file to lock) or `source` (a snapshot id).",
    );
  } else {
    const added = await service.add([options.spec]);
    if (added.snapshot?.status !== "valid") {
      return {
        ok: false,
        stage: "source",
        diagnostics: [
          ...added.diagnostics,
          {
            level: "error",
            code: "source/not_compilable",
            message: added.snapshot
              ? `Snapshot ${added.snapshot.snapshotId} is ${added.snapshot.status}; nothing was compiled.`
              : `'${options.spec}' could not be read; nothing was locked or compiled.`,
          },
        ],
      };
    }
    resolved = await service.compilerSource(added.snapshot.snapshotId, options.entrypoint);
  }
  if (!resolved.source) return { ok: false, stage: "source", diagnostics: resolved.diagnostics };

  let manifestText = options.manifestText;
  if (options.manifest !== undefined) {
    if (!existsSync(options.manifest)) {
      return fail(
        "manifest",
        "manifest/not_found",
        `Manifest '${options.manifest}' does not exist; nothing was compiled.`,
      );
    }
    manifestText = readFileSync(options.manifest, "utf8");
  }
  if (manifestText !== undefined) {
    const parsed = parseManifestDetailed(manifestText);
    if (!parsed.ok) {
      return {
        ok: false,
        stage: "manifest",
        manifestIssues: parsed.issues,
        diagnostics: parsed.issues.map((issue) => ({
          level: "error" as const,
          code: "manifest/invalid",
          message: formatManifestIssue(issue, options.manifest),
          ...(issue.path ? { path: issue.path } : {}),
        })),
      };
    }
  }

  const air = await compileSource(resolved.source, {
    manifest: manifestText,
    serviceId: options.serviceId,
    humanApproval: options.humanApproval,
  });
  // A bundle with error diagnostics is still written — exactly as the command
  // always has — so the operator can inspect what compiled; `diagnostics`
  // carries the errors and the CLI exits non-zero on them.
  const outDir = options.out ?? join("generated", air.service.id);
  const bundle = generateBundle(air, { mcpEndpoint: options.endpoint });
  const written = installGeneratedBundle(outDir, bundle, {
    onCleanupWarning: (message) => options.onWarning?.(message),
  });
  return {
    ok: true,
    air,
    snapshotId: resolved.source.snapshotId,
    outDir,
    written,
    diagnostics: air.diagnostics,
  };
}

/** Whether a compiled result carries error-level diagnostics. */
export function compileHasErrors(result: CompileBundleResult): boolean {
  return result.diagnostics.some((d) => d.level === "error");
}

function fail(stage: "source" | "manifest", code: string, message: string): CompileBundleResult {
  return { ok: false, stage, diagnostics: [{ level: "error", code, message }] };
}
