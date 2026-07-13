import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ApiConnectGatewayAdapter,
  ApigeeGatewayAdapter,
  ArchiveDecodeError,
  compileContract,
  decodeArchiveText,
  type GatewayAdapter,
  type GatewayConnection,
  type GatewayDiagnostic,
  KongGatewayAdapter,
  MulesoftGatewayAdapter,
  readArchive,
  sniffArchiveFormat,
  Wso2GatewayAdapter,
  ZipArchiveDecoder,
} from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil estate` — the CLI seam onto the gateway adapters (ADR-0021). Reads a
 * vendor export (a bare config document, or a ZIP/JAR archive decoded through
 * the hardened archive harness of ADR-0020), inventories the estate, and
 * imports one API through the one compiler path into a normal bundle. Nothing
 * vendor-specific survives past the adapter: `import` is `GatewayApiImport
 * { source, overlay }` → `compileContract` → `generateBundle`, so a gateway
 * estate gets the same CLI/MCP/skill/hook artifacts — and the same approval
 * gate — as any spec.
 */

/** Every vendor connection is `{ id, config, origin }` — the uniformity is the point. */
interface EstateConnection extends GatewayConnection {
  config: string;
  origin?: string;
}

const VENDORS: Record<string, () => GatewayAdapter<EstateConnection>> = {
  kong: () => new KongGatewayAdapter(),
  apigee: () => new ApigeeGatewayAdapter(),
  wso2: () => new Wso2GatewayAdapter(),
  mulesoft: () => new MulesoftGatewayAdapter(),
  api_connect: () => new ApiConnectGatewayAdapter(),
};

const VENDOR_LIST = Object.keys(VENDORS).join(" | ");

export function registerEstate(parent: Command, ctx: CommandContext): void {
  const estate = parent
    .command("estate")
    .summary("Inventory and import gateway estates (Apigee, Kong, WSO2, MuleSoft, API Connect).")
    .description(
      "Reads a vendor gateway export — a bare config document, or a ZIP/JAR archive (decoded through the hardened archive harness: zip-slip, symlink, and bomb defences with every rejection reported) — and normalizes it through the vendor adapter into the one compiler pipeline. " +
        "`inventory` lists the estate's APIs without compiling anything; `import` compiles one API into a normal Anvil bundle, where the usual approval gate applies: risky operations land review_required and are not exposed until approved.",
    );

  annotate(
    estate
      .command("inventory")
      .summary("List the APIs in a gateway export without compiling anything.")
      .argument("<export>", "vendor export: a config file or a ZIP/JAR archive")
      .requiredOption("--vendor <vendor>", `gateway vendor (${VENDOR_LIST})`)
      .option("--entry <path>", "archive entry holding the config, when the archive has several")
      .option("--json", "emit the inventory snapshot as JSON")
      .action(async (exportPath: string, opts: InventoryOptions) => {
        ctx.code = await runInventory(exportPath, opts, ctx.io);
      }),
    { mutates: false },
  );

  annotate(
    estate
      .command("import")
      .summary("Import one API from a gateway export and compile it into a bundle.")
      .argument("<export>", "vendor export: a config file or a ZIP/JAR archive")
      .requiredOption("--vendor <vendor>", `gateway vendor (${VENDOR_LIST})`)
      .option("--api <id>", "API id from `estate inventory` (optional when the estate has one)")
      .option("--entry <path>", "archive entry holding the config, when the archive has several")
      .option("--service <id>", "override the derived service id")
      .option("--out <dir>", "bundle output directory (default generated/<service-id>)")
      .option("--json", "emit a machine-readable import report (for CI oracles)")
      .action(async (exportPath: string, opts: ImportOptions) => {
        ctx.code = await runImport(exportPath, opts, ctx.io);
      }),
    { mutates: true },
  );
}

interface InventoryOptions {
  vendor: string;
  entry?: string;
  json?: boolean;
}
interface ImportOptions extends InventoryOptions {
  api?: string;
  service?: string;
  out?: string;
  json?: boolean;
}

/** Resolve the vendor adapter or explain the valid set. */
function adapterFor(vendor: string, io: CliIO): GatewayAdapter<EstateConnection> | undefined {
  const make = VENDORS[vendor];
  if (!make) io.err(`Unknown --vendor '${vendor}'. Use: ${VENDOR_LIST}.`);
  return make?.();
}

const CONFIG_EXTENSIONS = [".json", ".yaml", ".yml", ".xml"];

/**
 * Load the vendor config text from the export path. A ZIP/JAR goes through the
 * archive harness (rejections are printed, never silent); anything that sniffs
 * as another container is refused by name; everything else is read as UTF-8
 * text directly.
 */
function loadEstateConfig(
  exportPath: string,
  entry: string | undefined,
  io: CliIO,
): { config: string; origin: string } | undefined {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(exportPath);
  } catch (err) {
    io.err(`Cannot read '${exportPath}': ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }

  const format = sniffArchiveFormat(bytes);
  if (format === "tar" || format === "gzip") {
    io.err(
      `'${exportPath}' is a ${format} container, which has no decoder yet — supply a ZIP/JAR export or the extracted config file.`,
    );
    return undefined;
  }

  if (format !== "zip") {
    const text = decodeArchiveText({ path: exportPath, bytes });
    if (!text.ok) {
      io.err(`'${exportPath}' is not valid UTF-8 text (and not a ZIP archive).`);
      return undefined;
    }
    return { config: text.text, origin: exportPath };
  }

  let result: ReturnType<typeof readArchive>;
  try {
    result = readArchive(bytes, new ZipArchiveDecoder());
  } catch (err) {
    if (err instanceof ArchiveDecodeError) {
      io.err(`Archive refused: ${err.message}`);
      return undefined;
    }
    throw err;
  }
  for (const d of result.diagnostics) {
    io.err(`${d.level}: [${d.code}] ${d.message}${d.path ? ` (${d.path})` : ""}`);
  }
  if (!result.ok) {
    io.err("Archive rejected by the safety battery; nothing was imported.");
    return undefined;
  }

  const candidates = entry
    ? result.files.filter((f) => f.path === entry)
    : result.files.filter((f) => CONFIG_EXTENSIONS.some((ext) => f.path.endsWith(ext)));
  if (candidates.length === 0) {
    io.err(
      entry
        ? `Archive has no entry '${entry}'. Entries: ${result.files.map((f) => f.path).join(", ")}`
        : `Archive has no config-like entry (${CONFIG_EXTENSIONS.join("/")}). Use --entry <path>.`,
    );
    return undefined;
  }
  if (candidates.length > 1) {
    io.err(
      `Archive has ${candidates.length} config-like entries — pick one with --entry <path>:\n  ${candidates.map((f) => f.path).join("\n  ")}`,
    );
    return undefined;
  }
  const file = candidates[0];
  if (!file) return undefined;
  const text = decodeArchiveText(file);
  if (!text.ok) {
    io.err(`Archive entry '${file.path}' is not valid UTF-8 text.`);
    return undefined;
  }
  return { config: text.text, origin: `${exportPath}!${file.path}` };
}

function printDiagnostics(io: CliIO, diagnostics: readonly GatewayDiagnostic[]): void {
  for (const d of diagnostics) {
    const where = d.coordinate ? ` @ ${d.coordinate.origin}:${d.coordinate.pointer ?? ""}` : "";
    io.out(`  ${d.level}: [${d.code}] ${d.message}${where}`);
  }
}

async function runInventory(
  exportPath: string,
  opts: InventoryOptions,
  io: CliIO,
): Promise<number> {
  const adapter = adapterFor(opts.vendor, io);
  if (!adapter) return 1;
  const loaded = loadEstateConfig(exportPath, opts.entry, io);
  if (!loaded) return 1;

  const snapshot = await adapter.inventory(
    { id: `${opts.vendor}-estate`, config: loaded.config, origin: loaded.origin },
    {},
  );
  if (opts.json) {
    io.out(JSON.stringify(snapshot, null, 2));
  } else {
    io.out(`${snapshot.apis.length} API(s) in ${opts.vendor} estate ${loaded.origin}:`);
    for (const api of snapshot.apis) {
      const routes = api.routes.length ? ` · ${api.routes.length} route(s)` : "";
      const auth = api.authSummary ? ` · ${api.authSummary}` : "";
      io.out(`  ${api.id} — ${api.name}${routes}${auth}`);
    }
    if (snapshot.diagnostics.length > 0) {
      io.out("Diagnostics:");
      printDiagnostics(io, snapshot.diagnostics);
    }
  }
  return snapshot.diagnostics.some((d) => d.level === "error") ? 1 : 0;
}

async function runImport(exportPath: string, opts: ImportOptions, io: CliIO): Promise<number> {
  const adapter = adapterFor(opts.vendor, io);
  if (!adapter) return 1;
  const loaded = loadEstateConfig(exportPath, opts.entry, io);
  if (!loaded) return 1;

  const connection: EstateConnection = {
    id: `${opts.vendor}-estate`,
    config: loaded.config,
    origin: loaded.origin,
  };
  const snapshot = await adapter.inventory(connection, {});
  if (snapshot.apis.length === 0) {
    io.err("The estate has no APIs to import.");
    printDiagnostics(io, snapshot.diagnostics);
    return 1;
  }
  const apiRef = opts.api
    ? snapshot.apis.find((a) => a.id === opts.api)
    : snapshot.apis.length === 1
      ? snapshot.apis[0]
      : undefined;
  if (!apiRef) {
    io.err(
      opts.api
        ? `No API '${opts.api}' in this estate. Available: ${snapshot.apis.map((a) => a.id).join(", ")}`
        : `The estate has ${snapshot.apis.length} APIs — pick one with --api <id>:\n  ${snapshot.apis.map((a) => a.id).join("\n  ")}`,
    );
    return 1;
  }

  const imported = await adapter.extractApi(connection, { id: apiRef.id, name: apiRef.name }, {});
  const opaque = imported.diagnostics.filter((d) => d.code.includes("opaque"));
  const result = await compileContract(imported.source, [imported.overlay], {
    serviceId: opts.service,
  });
  if (result.status === "conflicted") {
    io.err(`Import conflicted: ${result.conflicts.length} unresolved safety conflict(s).`);
    for (const c of result.conflicts) io.err(`  ${c.predicate}: ${c.message}`);
    return 1;
  }

  const air = result.contract.air;
  const outDir = opts.out ?? join("generated", air.service.id);
  const written = writeBundle(outDir, generateBundle(air));

  const approved = air.operations.filter((o) => o.state === "approved").length;
  const review = air.operations.filter((o) => o.state === "review_required").length;
  if (opts.json) {
    // The machine-readable report CI oracles gate on (policy accounting: opaque
    // findings are DATA here, so a corpus baseline can pin their exact count).
    io.out(
      JSON.stringify(
        {
          vendor: opts.vendor,
          api: apiRef.id,
          serviceId: air.service.id,
          out: outDir,
          files: written.length,
          operations: { total: air.operations.length, approved, review_required: review },
          opaque: opaque.map((d) => ({ code: d.code, message: d.message })),
          diagnostics: imported.diagnostics.length,
        },
        null,
        2,
      ),
    );
    return imported.diagnostics.some((d) => d.level === "error") ? 1 : 0;
  }
  io.out(
    `Imported ${apiRef.id} from the ${opts.vendor} estate → ${outDir} (${written.length} files).`,
  );
  io.out(
    `  operations: ${air.operations.length}  approved: ${approved}  review_required: ${review}`,
  );
  if (opaque.length > 0) {
    io.out(
      `  ⚠ ${opaque.length} opaque polic${opaque.length === 1 ? "y" : "ies"} — the gateway rewrites traffic in ways the adapter cannot prove it understands; certification is blocked until they are reviewed:`,
    );
    printDiagnostics(io, opaque);
  }
  if (imported.diagnostics.length > opaque.length) {
    io.out("Diagnostics:");
    printDiagnostics(
      io,
      imported.diagnostics.filter((d) => !d.code.includes("opaque")),
    );
  }
  if (review > 0)
    io.out(`  Run \`anvil inspect ${outDir}\` then \`anvil approve\` to expose more.`);
  return imported.diagnostics.some((d) => d.level === "error") ? 1 : 0;
}
