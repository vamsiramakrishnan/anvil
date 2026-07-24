import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type AirDocument, airFromJson, type Operation } from "@anvil/air";
import {
  ApiConnectGatewayAdapter,
  ApigeeGatewayAdapter,
  ArchiveDecodeError,
  BUDGET_WAIVED_CODE,
  BUDGET_WARNING_CODE,
  buildGatewayOverlay,
  compileContract,
  decodeArchiveText,
  FileSystemGatewayImportReceiptStore,
  finalizeGatewayImportReceipt,
  type GatewayAdapter,
  type GatewayConnection,
  type GatewayContractProvenance,
  type GatewayDiagnostic,
  type GatewayFact,
  type GatewayImportReceipt,
  type GatewayImportReceiptDraft,
  GatewayImportReceiptView,
  type GatewayPolicyOverlay,
  gatewayBundleManifest,
  gatewayCapabilityReviewInput,
  gatewayManifestDigest,
  gatewaySha256,
  isGatewayLifecycleArtifact,
  KongGatewayAdapter,
  MulesoftGatewayAdapter,
  makeOverlay,
  parseManifest,
  readArchive,
  redactGatewayImportReceipt,
  sniffArchiveFormat,
  verifyGatewayImportOutput,
  verifyGatewayImportOutputManifest,
  Wso2GatewayAdapter,
  withoutRouteOnlyGuard,
  ZipArchiveDecoder,
} from "@anvil/compiler";
import {
  type GeneratedBundle,
  generateBundle,
  readBundleDir,
  writeBundle,
} from "@anvil/generators";
import { GEMINI_ENTERPRISE_PROFILE, verifyTargetKit } from "@anvil/targets";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { printDiagnostics as printSourceDiagnostics, sourceService } from "./source.js";

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
      .option(
        "--spec <path>",
        "original OpenAPI/Swagger contract; lock it and apply gateway policies instead of compiling route-only synthesis",
      )
      .option(
        "--manifest <path>",
        "supplemental Anvil manifest, including exact-id capability reviews, applied in the receipt-bound compile",
      )
      .option(
        "--gateway-url <url>",
        "operator-attested public HTTPS gateway base URL; required with --spec so generated tools cannot bypass the gateway",
      )
      .option("--root <dir>", "workspace root for the locked source under .anvil/sources", ".")
      .option("--service <id>", "override the derived service id")
      .option("--out <dir>", "bundle output directory (default generated/<service-id>)")
      .option(
        "--replace-derived",
        "replace a receipt-backed bundle whose output lineage became stale after approval, only after its recorded current digest verifies; verified later lifecycle artifacts are explicitly discarded",
      )
      .option("--json", "emit a machine-readable import report (for CI oracles)")
      .action(async (exportPath: string, opts: ImportOptions) => {
        ctx.code = await runImport(exportPath, opts, ctx.io, ctx.deps);
      }),
    { mutates: true },
  );

  annotate(
    estate
      .command("verify")
      .summary("Verify an immutable gateway import receipt and its bound evidence.")
      .argument("<import-id>", "the content-derived gateway import id")
      .option("--root <dir>", "workspace root for .anvil/imports and .anvil/sources", ".")
      .option("--bundle <dir>", "also verify the generated output files against the receipt")
      .option("--json", "emit a machine-readable integrity report")
      .action(async (importId: string, opts: VerifyOptions) => {
        ctx.code = await runVerify(importId, opts, ctx.io);
      }),
    { mutates: false },
  );
}

interface InventoryOptions {
  vendor: string;
  entry?: string;
  json?: boolean;
}
interface ImportOptions extends InventoryOptions {
  api?: string;
  spec?: string;
  manifest?: string;
  gatewayUrl?: string;
  root?: string;
  service?: string;
  out?: string;
  replaceDerived?: boolean;
  json?: boolean;
}

function normalizeGatewayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid --gateway-url '${value}': expected an absolute HTTPS URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Invalid --gateway-url '${value}': the public gateway URL must use HTTPS.`);
  }
  if (url.username || url.password) {
    throw new Error(`Invalid --gateway-url '${value}': embedded credentials are not allowed.`);
  }
  if (url.search || url.hash) {
    throw new Error(
      `Invalid --gateway-url '${value}': query strings and fragments are not allowed.`,
    );
  }
  url.pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
  return url.toString();
}
interface VerifyOptions {
  root?: string;
  bundle?: string;
  json?: boolean;
}

/** Resolve the vendor adapter or explain the valid set. */
function adapterFor(vendor: string, io: CliIO): GatewayAdapter<EstateConnection> | undefined {
  const make = VENDORS[vendor];
  if (!make) io.err(`Unknown --vendor '${vendor}'. Use: ${VENDOR_LIST}.`);
  return make?.();
}

const CONFIG_EXTENSIONS = [".json", ".yaml", ".yml", ".xml"];

interface LoadedEstateConfig {
  config: string;
  origin: string;
  /** Verbatim outer container bytes, even when config came from a ZIP member. */
  exportBytes: Uint8Array;
  exportFormat: "text" | "zip";
  archiveEntry?: string;
}

function portableGatewayOrigin(loaded: LoadedEstateConfig): string {
  const digest = gatewaySha256(loaded.exportBytes);
  return `gateway-export://${digest}${loaded.archiveEntry ? `!${loaded.archiveEntry}` : ""}`;
}

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
): LoadedEstateConfig | undefined {
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
    return {
      config: text.text,
      origin: exportPath,
      exportBytes: bytes,
      exportFormat: "text",
    };
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
  return {
    config: text.text,
    origin: `${exportPath}!${file.path}`,
    exportBytes: bytes,
    exportFormat: "zip",
    archiveEntry: file.path,
  };
}

function printDiagnostics(io: CliIO, diagnostics: readonly GatewayDiagnostic[]): void {
  for (const d of diagnostics) {
    const where = d.coordinate ? ` @ ${d.coordinate.origin}:${d.coordinate.pointer ?? ""}` : "";
    io.out(`  ${d.level}: [${d.code}] ${d.message}${where}`);
  }
}

function coordinateText(diagnostic: GatewayDiagnostic): string | undefined {
  const coordinate = diagnostic.coordinate;
  if (!coordinate) return undefined;
  const pointer = coordinate.pointer ? `#${coordinate.pointer}` : "";
  const span = coordinate.span ? `@${coordinate.span.start}-${coordinate.span.end}` : "";
  return `${coordinate.origin}${pointer}${span}`;
}

/** Gateway findings become durable AIR findings instead of disappearing after CLI output. */
function appendGatewayDiagnostics(
  air: AirDocument,
  diagnostics: readonly GatewayDiagnostic[],
): void {
  const seen = new Set(
    air.diagnostics.map((d) => JSON.stringify([d.level, d.code, d.message, d.path ?? null])),
  );
  for (const diagnostic of diagnostics) {
    const durable = {
      level: diagnostic.level,
      code: diagnostic.code,
      message: diagnostic.message,
      path: coordinateText(diagnostic),
    };
    const key = JSON.stringify([
      durable.level,
      durable.code,
      durable.message,
      durable.path ?? null,
    ]);
    if (!seen.has(key)) {
      air.diagnostics.push(durable);
      seen.add(key);
    }
  }
}

const SYNTHESIS_ONLY_DIAGNOSTICS = new Set([
  "gateway/route_only_contract",
  "gateway/missing_runtime_coordinate",
  "gateway/auth_contract_incomplete",
]);

function blocksGatewayImport(diagnostic: GatewayDiagnostic): boolean {
  return (
    diagnostic.level === "error" ||
    diagnostic.code === "gateway/route_only_contract" ||
    diagnostic.code === "gateway/missing_runtime_coordinate" ||
    diagnostic.code === "gateway/auth_contract_incomplete" ||
    diagnostic.code === "gateway/opaque_policy" ||
    diagnostic.code === "gateway/policy_target_unmatched" ||
    diagnostic.code === "gateway/route_set_missing" ||
    diagnostic.code === "gateway/route_set_extra" ||
    diagnostic.code === "gateway/route_set_ambiguous"
  );
}

function operationKeys(operation: Operation): string[] {
  return [operation.id, operation.canonicalName, operation.sourceRef.operationId].filter(
    (key): key is string => key !== undefined,
  );
}

function normalizedRoutePath(value: string): string | undefined {
  const path = value.trim();
  if (path === "") return undefined;
  const leadingSlash = path.startsWith("/") ? path : `/${path}`;
  return leadingSlash.replace(/\{\+?[^/{]+\}/g, "{}").replace(/(^|\/):[^/]+/g, "$1{}");
}

function routeKey(operation: Operation): string | undefined {
  const { method, path } = operation.sourceRef;
  const normalizedPath = path ? normalizedRoutePath(path) : undefined;
  return method && normalizedPath ? `${method.toUpperCase()} ${normalizedPath}` : undefined;
}

function routeMultiset(operations: readonly Operation[]): {
  routes: Map<string, Operation[]>;
  unattested: Operation[];
} {
  const routes = new Map<string, Operation[]>();
  const unattested: Operation[] = [];
  for (const operation of operations) {
    const key = routeKey(operation);
    if (!key) {
      unattested.push(operation);
      continue;
    }
    routes.set(key, [...(routes.get(key) ?? []), operation]);
  }
  return { routes, unattested };
}

/**
 * A supplied contract is authoritative only for API shape, not gateway
 * membership. Prove that it describes exactly the gateway's selected route
 * multiset before allowing any operation to escape the import guard.
 */
function attestGatewayRouteSet(
  synthesized: readonly Operation[],
  supplied: readonly Operation[],
  coordinate: GatewayContractProvenance["location"],
): GatewayDiagnostic[] {
  const gateway = routeMultiset(synthesized);
  const contract = routeMultiset(supplied);
  const diagnostics: GatewayDiagnostic[] = [];

  for (const operation of gateway.unattested) {
    diagnostics.push({
      level: "warning",
      code: "gateway/route_set_ambiguous",
      message: `Gateway operation '${operation.id}' has no attestable HTTP method/path coordinate.`,
      coordinate,
    });
  }
  for (const operation of contract.unattested) {
    diagnostics.push({
      level: "warning",
      code: "gateway/route_set_ambiguous",
      message: `Supplied contract operation '${operation.id}' has no attestable HTTP method/path coordinate.`,
      coordinate,
    });
  }

  const keys = [...new Set([...gateway.routes.keys(), ...contract.routes.keys()])].sort();
  for (const key of keys) {
    const gatewayCount = gateway.routes.get(key)?.length ?? 0;
    const contractCount = contract.routes.get(key)?.length ?? 0;
    if (gatewayCount > 1) {
      diagnostics.push({
        level: "warning",
        code: "gateway/route_set_ambiguous",
        message: `Gateway route '${key}' appears ${gatewayCount} times; an explicit reviewed route mapping is required.`,
        coordinate,
      });
    }
    if (contractCount > 1) {
      diagnostics.push({
        level: "warning",
        code: "gateway/route_set_ambiguous",
        message: `Supplied contract route '${key}' appears ${contractCount} times; an explicit reviewed route mapping is required.`,
        coordinate,
      });
    }
    if (gatewayCount > contractCount) {
      diagnostics.push({
        level: "warning",
        code: "gateway/route_set_missing",
        message: `Supplied contract is missing ${gatewayCount - contractCount} gateway operation(s) at '${key}'.`,
        coordinate,
      });
    } else if (contractCount > gatewayCount) {
      diagnostics.push({
        level: "warning",
        code: "gateway/route_set_extra",
        message: `Supplied contract contains ${contractCount - gatewayCount} operation(s) at '${key}' that are absent from the selected gateway API.`,
        coordinate,
      });
    }
  }
  return diagnostics;
}

/**
 * A native spec may use different operationIds from the gateway export. Match
 * policy targets through the route-only source's method/path and fail closed
 * when a target has no unique method/path peer in the supplied contract.
 */
function retargetGatewayOverlay(
  overlay: GatewayPolicyOverlay,
  synthesized: readonly Operation[],
  supplied: readonly Operation[],
  coordinate: GatewayContractProvenance["location"],
): { overlay: GatewayPolicyOverlay; diagnostics: GatewayDiagnostic[] } {
  const synthesizedByKey = new Map<string, Operation>();
  for (const operation of synthesized) {
    for (const key of operationKeys(operation)) synthesizedByKey.set(key, operation);
  }
  const suppliedByRoute = new Map<string, Operation[]>();
  for (const operation of supplied) {
    const key = routeKey(operation);
    if (key) suppliedByRoute.set(key, [...(suppliedByRoute.get(key) ?? []), operation]);
  }

  const diagnostics: GatewayDiagnostic[] = [];
  const diagnosed = new Set<string>();
  const assertions = overlay.assertions.flatMap((assertion) => {
    if (assertion.target.scope !== "operation") return [assertion];
    const synthesizedOperation = synthesizedByKey.get(assertion.target.ref);
    const key = synthesizedOperation ? routeKey(synthesizedOperation) : undefined;
    const candidates = key ? (suppliedByRoute.get(key) ?? []) : [];
    if (candidates.length === 1) {
      const suppliedOperation = candidates[0] as Operation;
      return [
        {
          ...assertion,
          target: {
            ...assertion.target,
            // Use the AIR id rather than a possibly colliding operationId.
            ref: suppliedOperation.id,
          },
        },
      ];
    }
    if (!diagnosed.has(assertion.target.ref)) {
      diagnostics.push({
        level: "warning",
        code: "gateway/policy_target_unmatched",
        message:
          candidates.length > 1
            ? `Gateway policy target '${assertion.target.ref}' maps to ${candidates.length} supplied operations at ${key}; no policy was applied automatically.`
            : `Gateway policy target '${assertion.target.ref}' has no unique method/path match in the supplied contract; no policy was applied automatically.`,
        coordinate,
      });
      diagnosed.add(assertion.target.ref);
    }
    // Do not leave a stale assertion in place: a colliding operationId could
    // otherwise make the resolver apply gateway policy to the wrong route.
    return [];
  });
  return {
    overlay: makeOverlay({
      origin: overlay.origin,
      id: `${overlay.id}_retargeted`,
      assertions,
      evidence: overlay.evidence,
    }),
    diagnostics,
  };
}

function gatewayGuardOverlay(
  operations: readonly Operation[],
  diagnostics: readonly GatewayDiagnostic[],
  fallback: GatewayContractProvenance["location"],
): GatewayPolicyOverlay | undefined {
  const blocking = diagnostics.filter(blocksGatewayImport);
  if (blocking.length === 0) return undefined;
  const coordinate = blocking.find((d) => d.coordinate)?.coordinate ?? fallback;
  const facts: GatewayFact[] = operations.map((operation) => ({
    target: {
      scope: "operation",
      ref: operation.sourceRef.operationId ?? operation.id,
    },
    predicate: "state",
    operation: "set",
    value: "blocked",
    coordinate,
    note: `Gateway import guard: ${blocking.map((d) => d.code).join(", ")}`,
  }));
  return buildGatewayOverlay(facts, "overlay_gateway_import_guard");
}

function receiptStore(opts: { root?: string }): FileSystemGatewayImportReceiptStore {
  return new FileSystemGatewayImportReceiptStore(join(opts.root ?? ".", ".anvil", "imports"));
}

function receiptOverlay(
  role: "gateway_policy" | "import_guard",
  overlay: GatewayPolicyOverlay,
): GatewayImportReceiptDraft["overlays"][number] {
  return {
    role,
    id: overlay.id,
    digest: overlay.digest,
    // Notes and assertion values can carry customer configuration; the receipt
    // needs only the evidence coordinates that bind the already-hashed overlay.
    evidence: overlay.evidence.map((evidence) => ({
      id: evidence.id,
      kind: evidence.kind,
      ref: evidence.ref,
    })),
  };
}

interface BundleInstallDiagnostic {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  path?: string;
}

interface BundleCommitResult {
  retainedBackup?: string;
  warning?: string;
}

type PreparedBundleInstall =
  | {
      ok: true;
      written: string[];
      directory: string;
      commit: () => BundleCommitResult;
      rollback: () => void;
    }
  | { ok: false; diagnostics: BundleInstallDiagnostic[] };

/** Enumerate a bundle as relative POSIX file paths and refuse non-file nodes. */
function listBundleFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error(`bundle contains unsupported filesystem node '${relativePath}'`);
      }
    }
  };
  visit(root, "");
  return files.sort();
}

function exactFileSetDiagnostics(
  actual: readonly string[],
  expected: readonly string[],
  allowedAdded: ReadonlySet<string> = new Set(),
): BundleInstallDiagnostic[] {
  const diagnostics: BundleInstallDiagnostic[] = [];
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  for (const path of expectedSet) {
    if (!actualSet.has(path)) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/output_missing",
        message: "Generated bundle is missing a recorded file.",
        path,
      });
    }
  }
  for (const path of actualSet) {
    if (!expectedSet.has(path) && !allowedAdded.has(path)) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/output_added",
        message: "Generated bundle contains a file outside the receipt manifest.",
        path,
      });
    }
  }
  return diagnostics;
}

interface GatewayLifecycleArtifacts {
  paths: Set<string>;
  diagnostics: BundleInstallDiagnostic[];
}

/**
 * Recognize post-import records and prove target-kit subtrees independently.
 * The `targets/` namespace is never trusted merely by name: only the known
 * Gemini Enterprise profile, regenerated exactly from canonical AIR, is safe
 * to preserve or ignore as lifecycle state.
 */
function gatewayLifecycleArtifacts(
  files: Record<string, string>,
  air: AirDocument,
): GatewayLifecycleArtifacts {
  const paths = new Set(Object.keys(files).filter((path) => isGatewayLifecycleArtifact(path)));
  const diagnostics: BundleInstallDiagnostic[] = [];
  const targetPaths = Object.keys(files).filter((path) => path.startsWith("targets/"));
  const targetIds = new Set(
    targetPaths
      .map((path) => /^targets\/([^/]+)\//.exec(path)?.[1])
      .filter((targetId): targetId is string => targetId !== undefined),
  );
  for (const targetId of targetIds) {
    if (targetId !== GEMINI_ENTERPRISE_PROFILE.id) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/unverified_target",
        message: `Target subtree '${targetId}' is not a recognized, independently verifiable lifecycle artifact; refusing to ignore or delete it.`,
        path: `targets/${targetId}`,
      });
      continue;
    }
    const verification = verifyTargetKit(air, GEMINI_ENTERPRISE_PROFILE, files);
    if (!verification.ok) {
      diagnostics.push(
        ...verification.findings.map((finding) => ({
          level: "error" as const,
          code: "gateway_receipt/unverified_target",
          message: finding.detail,
          path: finding.path,
        })),
      );
      continue;
    }
    for (const path of verification.actualFiles) paths.add(path);
  }
  for (const path of targetPaths) {
    if (!/^targets\/[^/]+\//.test(path)) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/unverified_target",
        message: "Target artifact has no verifiable target-profile subtree.",
        path,
      });
    }
  }
  return { paths, diagnostics };
}

function verifyBundleDirectory(
  root: string,
  receipt: GatewayImportReceipt,
  expectedFiles: readonly string[],
): BundleInstallDiagnostic[] {
  const diagnostics = exactFileSetDiagnostics(listBundleFiles(root), expectedFiles);
  const files = new Map<string, Uint8Array>();
  for (const expected of receipt.output.files) {
    const path = join(root, expected.path);
    if (existsSync(path)) files.set(expected.path, readFileSync(path));
  }
  diagnostics.push(...verifyGatewayImportOutput(receipt, files).diagnostics);
  try {
    const view = GatewayImportReceiptView.parse(
      JSON.parse(readFileSync(join(root, "import.receipt.json"), "utf8")),
    );
    if (view.importId !== receipt.importId || view.receiptDigest !== receipt.digest) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/bundle_receipt_mismatch",
        message: "Bundle receipt view does not identify the private receipt.",
        path: "import.receipt.json",
      });
    }
  } catch (err) {
    diagnostics.push({
      level: "error",
      code: "gateway_receipt/bundle_receipt_unparseable",
      message: `Bundle import.receipt.json is not a valid receipt view: ${(err as Error).message}`,
      path: "import.receipt.json",
    });
  }
  return diagnostics;
}

/**
 * Stage and verify a complete bundle, then swap it into place. An existing
 * directory is replaceable only when its prior receipt view proves every file
 * belongs to an earlier generated bundle; unknown files are never deleted.
 */
async function prepareBundleInstall(
  outDir: string,
  bundle: GeneratedBundle,
  receipt: GatewayImportReceipt,
  store: FileSystemGatewayImportReceiptStore,
  workspaceRoot: string,
  replaceDerived = false,
  deps: Pick<CommandContext["deps"], "cleanupGatewayBundleBackup"> = {},
): Promise<PreparedBundleInstall> {
  const directory = resolve(outDir);
  const parent = dirname(directory);
  const name = basename(directory);
  if (!name || directory === parent) {
    return {
      ok: false,
      diagnostics: [
        {
          level: "error",
          code: "gateway_receipt/unsafe_output_path",
          message: `Refusing to install a generated bundle at broad path '${directory}'.`,
        },
      ],
    };
  }
  let stage: string | undefined;
  let backup: string | undefined;
  let installed = false;
  try {
    mkdirSync(parent, { recursive: true });
    stage = mkdtempSync(join(parent, `.${name}.anvil-stage-`));
    const written = writeBundle(stage, bundle);
    const expected = Object.keys(bundle.files).sort();
    const stageDiagnostics = verifyBundleDirectory(stage, receipt, expected);
    if (stageDiagnostics.length > 0) return { ok: false, diagnostics: stageDiagnostics };

    if (existsSync(directory)) {
      if (!statSync(directory).isDirectory()) {
        return {
          ok: false,
          diagnostics: [
            {
              level: "error",
              code: "gateway_receipt/output_not_directory",
              message: `Bundle output '${directory}' exists and is not a directory.`,
            },
          ],
        };
      }
      let priorView: GatewayImportReceiptView;
      try {
        priorView = GatewayImportReceiptView.parse(
          JSON.parse(readFileSync(join(directory, "import.receipt.json"), "utf8")),
        );
      } catch {
        return {
          ok: false,
          diagnostics: [
            {
              level: "error",
              code: "gateway_receipt/unmanaged_output",
              message:
                "Existing output has no valid gateway receipt view; refusing to replace or delete its files.",
              path: directory,
            },
          ],
        };
      }
      const priorReceipt = await store.verify(priorView.importId);
      const expectedPriorView = priorReceipt.receipt
        ? redactGatewayImportReceipt(priorReceipt.receipt, { workspaceRoot })
        : undefined;
      const normalizedPriorView =
        priorView.lineage.status === "stale"
          ? { ...priorView, lineage: { status: "bound" as const } }
          : priorView;
      if (
        !priorReceipt.ok ||
        priorView.receiptDigest !== priorReceipt.receipt?.digest ||
        JSON.stringify(normalizedPriorView) !== JSON.stringify(expectedPriorView)
      ) {
        return {
          ok: false,
          diagnostics: [
            {
              level: "error",
              code: "gateway_receipt/untrusted_output",
              message:
                "Existing output receipt view is not backed by the intact private receipt in this workspace; refusing to replace or delete its files.",
              path: directory,
            },
          ],
        };
      }
      const existingFiles = readBundleDir(directory);
      let existingAir: AirDocument;
      try {
        existingAir = airFromJson(existingFiles["air.json"] ?? "");
      } catch (err) {
        return {
          ok: false,
          diagnostics: [
            {
              level: "error",
              code: "gateway_receipt/output_air_unreadable",
              message: `Existing canonical AIR cannot validate lifecycle artifacts: ${err instanceof Error ? err.message : String(err)}`,
              path: "air.json",
            },
          ],
        };
      }
      const recognizedLifecycle = gatewayLifecycleArtifacts(existingFiles, existingAir);
      if (recognizedLifecycle.diagnostics.length > 0) {
        return { ok: false, diagnostics: recognizedLifecycle.diagnostics };
      }
      if (priorView.lineage.status === "stale") {
        if (!replaceDerived) {
          return {
            ok: false,
            diagnostics: [
              {
                level: "error",
                code: "gateway_receipt/stale_output_requires_replace",
                message:
                  "Existing output was deliberately changed after gateway import. Re-run with --replace-derived to discard the derived approval state after its recorded digest is verified.",
                path: directory,
              },
            ],
          };
        }
        const generatedPaths = new Set(Object.keys(generateBundle(existingAir).files));
        const untrustedPaths = priorView.lineage.currentOutputFiles
          .map((file) => file.path)
          .filter((path) => !generatedPaths.has(path) && !recognizedLifecycle.paths.has(path));
        if (untrustedPaths.length > 0) {
          return {
            ok: false,
            diagnostics: [
              {
                level: "error",
                code: "gateway_receipt/stale_manifest_untrusted_path",
                message:
                  "The stale-lineage manifest names files that are neither deterministic compiler output nor independently recognized lifecycle artifacts; refusing to delete them.",
                path: untrustedPaths[0],
              },
            ],
          };
        }
        const currentFiles = new Map<string, Uint8Array>();
        for (const expected of priorView.lineage.currentOutputFiles) {
          const path = join(directory, expected.path);
          if (existsSync(path)) currentFiles.set(expected.path, readFileSync(path));
        }
        const currentIntegrity = verifyGatewayImportOutputManifest(
          {
            digest: priorView.lineage.currentOutputDigest,
            files: priorView.lineage.currentOutputFiles,
          },
          currentFiles,
        );
        if (!currentIntegrity.ok) {
          return {
            ok: false,
            diagnostics: [
              {
                level: "error",
                code: "gateway_receipt/stale_output_changed",
                message: `Existing derived output no longer matches the exact staged state recorded at approval: ${currentIntegrity.diagnostics.map((diagnostic) => `${diagnostic.path ? `${diagnostic.path}: ` : ""}${diagnostic.message}`).join("; ")}`,
                path: directory,
              },
            ],
          };
        }
        for (const file of priorView.lineage.currentOutputFiles) {
          recognizedLifecycle.paths.add(file.path);
        }
      }
      const priorExpected = [
        ...priorView.output.files.map((file) => file.path),
        "import.receipt.json",
      ].sort();
      const extras = exactFileSetDiagnostics(
        listBundleFiles(directory),
        priorExpected,
        recognizedLifecycle.paths,
      ).filter((diagnostic) => diagnostic.code === "gateway_receipt/output_added");
      if (extras.length > 0) return { ok: false, diagnostics: extras };

      if (!replaceDerived && recognizedLifecycle.paths.size > 0) {
        let candidateAir: AirDocument;
        try {
          candidateAir = airFromJson(bundle.files["air.json"] ?? "");
        } catch (err) {
          return {
            ok: false,
            diagnostics: [
              {
                level: "error",
                code: "gateway_receipt/candidate_air_unreadable",
                message: `Candidate canonical AIR cannot validate lifecycle artifacts: ${err instanceof Error ? err.message : String(err)}`,
                path: "air.json",
              },
            ],
          };
        }
        const compatibleLifecycle = gatewayLifecycleArtifacts(existingFiles, candidateAir);
        if (compatibleLifecycle.diagnostics.length > 0) {
          return {
            ok: false,
            diagnostics: compatibleLifecycle.diagnostics.map((diagnostic) => ({
              ...diagnostic,
              code: "gateway_receipt/lifecycle_incompatible",
              message: `${diagnostic.message} Move or remove the artifact, or re-run with --replace-derived to discard verified derived state.`,
            })),
          };
        }
        const expectedSet = new Set(expected);
        for (const relativePath of compatibleLifecycle.paths) {
          if (expectedSet.has(relativePath)) {
            return {
              ok: false,
              diagnostics: [
                {
                  level: "error",
                  code: "gateway_receipt/lifecycle_collision",
                  message:
                    "A lifecycle artifact collides with a compiler-owned candidate file; refusing replacement.",
                  path: relativePath,
                },
              ],
            };
          }
          const destination = join(stage, relativePath);
          mkdirSync(dirname(destination), { recursive: true });
          copyFileSync(join(directory, relativePath), destination);
          written.push(relativePath);
        }
      }

      backup = mkdtempSync(join(parent, `.${name}.anvil-previous-`));
      rmSync(backup, { recursive: true, force: true });
      renameSync(directory, backup);
    }
    try {
      renameSync(stage, directory);
      installed = true;
    } catch (err) {
      if (backup && existsSync(backup) && !existsSync(directory)) renameSync(backup, directory);
      throw err;
    }

    let closed = false;
    return {
      ok: true,
      written,
      directory,
      commit: () => {
        if (closed) return {};
        closed = true;
        if (!backup) return {};
        try {
          (
            deps.cleanupGatewayBundleBackup ??
            ((path: string) => rmSync(path, { recursive: true, force: true }))
          )(backup);
          return {};
        } catch (err) {
          const retainedBackup = existsSync(backup) ? backup : undefined;
          const detail = err instanceof Error ? err.message : String(err);
          return {
            retainedBackup,
            warning: retainedBackup
              ? `The new gateway bundle was installed successfully, but the previous bundle backup could not be removed and remains at ${retainedBackup}: ${detail}`
              : `The new gateway bundle was installed successfully, but backup cleanup reported an error: ${detail}`,
          };
        }
      },
      rollback: () => {
        if (closed) return;
        rmSync(directory, { recursive: true, force: true });
        if (backup && existsSync(backup)) renameSync(backup, directory);
        closed = true;
      },
    };
  } catch (err) {
    if (backup && existsSync(backup) && !existsSync(directory)) renameSync(backup, directory);
    return {
      ok: false,
      diagnostics: [
        {
          level: "error",
          code: "gateway_receipt/output_install_failed",
          message: err instanceof Error ? err.message : String(err),
          path: directory,
        },
      ],
    };
  } finally {
    if (!installed && stage) rmSync(stage, { recursive: true, force: true });
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
    {
      id: `${opts.vendor}-estate`,
      config: loaded.config,
      origin: portableGatewayOrigin(loaded),
    },
    {},
  );
  if (opts.json) {
    io.out(JSON.stringify(snapshot, null, 2));
  } else {
    io.out(`${snapshot.apis.length} API(s) in ${opts.vendor} estate ${loaded.origin}:`);
    for (const api of snapshot.apis) {
      const routes = api.routes.length ? ` · ${api.routes.length} route(s)` : "";
      const auth = api.authSummary ? ` · ${api.authSummary}` : "";
      const contract = api.contract
        ? ` · contract ${api.contract.kind}/${api.contract.fidelity} @ ${api.contract.location.origin}${api.contract.location.pointer ? `#${api.contract.location.pointer}` : ""}`
        : " · contract provenance unavailable";
      io.out(`  ${api.id} — ${api.name}${routes}${auth}${contract}`);
    }
    if (snapshot.diagnostics.length > 0) {
      io.out("Diagnostics:");
      printDiagnostics(io, snapshot.diagnostics);
    }
  }
  return snapshot.diagnostics.some((d) => d.level === "error") ? 1 : 0;
}

async function runImport(
  exportPath: string,
  opts: ImportOptions,
  io: CliIO,
  deps: Pick<CommandContext["deps"], "cleanupGatewayBundleBackup"> = {},
): Promise<number> {
  if (opts.spec && !opts.gatewayUrl) {
    io.err(
      "`--gateway-url <https://gateway.example/base>` is required with `--spec`; Anvil will not trust a contract's server as proof that calls still traverse the imported gateway.",
    );
    return 1;
  }
  let gatewayUrl: string | undefined;
  if (opts.gatewayUrl) {
    try {
      gatewayUrl = normalizeGatewayUrl(opts.gatewayUrl);
    } catch (err) {
      io.err(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }
  let manifest: string | undefined;
  let compilerInput: GatewayImportReceiptDraft["compilerInput"];
  if (opts.manifest) {
    try {
      manifest = readFileSync(opts.manifest, "utf8");
      const parsedManifest = parseManifest(manifest);
      const capabilityReviews = gatewayCapabilityReviewInput(parsedManifest.capabilities);
      compilerInput = {
        manifestDigest: gatewayManifestDigest(parsedManifest),
        ...(capabilityReviews ? { capabilityReviews } : {}),
      };
    } catch (error) {
      io.err(
        `Cannot read or parse --manifest '${opts.manifest}': ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }

  const adapter = adapterFor(opts.vendor, io);
  if (!adapter) return 1;
  const loaded = loadEstateConfig(exportPath, opts.entry, io);
  if (!loaded) return 1;

  const connection: EstateConnection = {
    id: `${opts.vendor}-estate`,
    config: loaded.config,
    origin: portableGatewayOrigin(loaded),
  };
  const snapshot = await adapter.inventory(connection, {});
  if (snapshot.diagnostics.some((diagnostic) => diagnostic.level === "error")) {
    io.err("The gateway inventory is ambiguous or invalid; nothing was imported.");
    printDiagnostics(io, snapshot.diagnostics);
    return 1;
  }
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
  let source = imported.source;
  let overlay = imported.overlay;
  let contract = imported.contract;
  let diagnostics = [...imported.diagnostics];
  let locked:
    | {
        directory: string;
        created: boolean;
        snapshotId: string;
        sourceHash: string;
        entrypoint: string;
      }
    | undefined;
  let lockedSourceReceipt: GatewayImportReceiptDraft["lockedSource"];
  let sourceDiagnostics: unknown[] = [];

  if (opts.spec) {
    const service = sourceService(opts);
    const added = await service.add([opts.spec], {
      name: `${opts.vendor}:${apiRef.id}`,
      originKind: adapter.kind,
      metadata: { workspace: opts.root },
    });
    sourceDiagnostics = added.diagnostics;
    if (added.snapshot?.status !== "valid" || !added.dir) {
      if (opts.json) {
        io.out(
          JSON.stringify(
            {
              vendor: opts.vendor,
              api: apiRef.id,
              source: {
                snapshot: added.snapshot,
                directory: added.dir,
                created: added.created,
                diagnostics: added.diagnostics,
              },
            },
            null,
            2,
          ),
        );
      } else {
        printSourceDiagnostics(io, added.diagnostics);
        io.err(
          added.snapshot
            ? `Supplied contract snapshot ${added.snapshot.snapshotId} is ${added.snapshot.status}; gateway import stopped before compilation.`
            : `Supplied contract '${opts.spec}' could not be read; nothing was compiled.`,
        );
      }
      return 1;
    }
    const bound = await service.compilerSource(added.snapshot.snapshotId);
    if (!bound.source) {
      if (opts.json) {
        io.out(
          JSON.stringify(
            {
              vendor: opts.vendor,
              api: apiRef.id,
              source: {
                snapshotId: added.snapshot.snapshotId,
                directory: added.dir,
                diagnostics: bound.diagnostics,
              },
            },
            null,
            2,
          ),
        );
      } else {
        printSourceDiagnostics(io, bound.diagnostics);
        io.err("The locked contract could not be prepared for compilation.");
      }
      return 1;
    }

    source = {
      ...bound.source,
      origin: {
        kind: adapter.kind,
        uri: `source://${added.snapshot.snapshotId}/${bound.source.entrypoint.path}`,
      },
    };
    lockedSourceReceipt = {
      schemaVersion: 1,
      snapshotId: added.snapshot.snapshotId,
      sourceHash: added.snapshot.sourceHash,
      status: added.snapshot.status,
      entrypoints: [...added.snapshot.entrypoints].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      ),
      files: [...added.snapshot.files].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      ),
      diagnostics: added.snapshot.diagnostics,
    };
    locked = {
      directory: resolve(added.dir),
      created: added.created ?? false,
      snapshotId: source.snapshotId,
      sourceHash: source.sourceHash,
      entrypoint: source.entrypoint.path,
    };
    contract = {
      kind: "native",
      fidelity: "full",
      format: source.entrypoint.format,
      version: source.entrypoint.version,
      location: {
        origin: `$WORKSPACE/.anvil/sources/${added.snapshot.snapshotId}/raw`,
        pointer: source.entrypoint.path,
      },
      source: {
        snapshotId: source.snapshotId,
        sourceHash: source.sourceHash,
        entrypoint: source.entrypoint.path,
      },
    };
    diagnostics = diagnostics.filter((d) => !SYNTHESIS_ONLY_DIAGNOSTICS.has(d.code));

    const synthesizedPreview = await compileContract(imported.source, []);
    const suppliedPreview = await compileContract(source, []);
    const synthesizedAir =
      synthesizedPreview.status === "resolved"
        ? synthesizedPreview.contract.air
        : synthesizedPreview.partialContract.air;
    const suppliedAir =
      suppliedPreview.status === "resolved"
        ? suppliedPreview.contract.air
        : suppliedPreview.partialContract.air;
    diagnostics.push(
      ...attestGatewayRouteSet(
        synthesizedAir.operations,
        suppliedAir.operations,
        contract.location,
      ),
    );
    const retargeted = retargetGatewayOverlay(
      withoutRouteOnlyGuard(imported.overlay),
      synthesizedAir.operations,
      suppliedAir.operations,
      contract.location,
    );
    overlay = retargeted.overlay;
    diagnostics.push(...retargeted.diagnostics);
  }

  if (gatewayUrl) {
    diagnostics = diagnostics.filter((d) => d.code !== "gateway/missing_runtime_coordinate");
    diagnostics.push({
      level: "info",
      code: "gateway/runtime_coordinate_attested",
      message: `Operator attested '${gatewayUrl}' as the public gateway base URL; generated runtime coordinates are pinned to it.`,
      coordinate: contract.location,
    });
  }

  let result = await compileContract(source, [overlay], {
    serviceId: opts.service,
    manifest,
  });
  if (result.status === "conflicted") {
    io.err(`Import conflicted: ${result.conflicts.length} unresolved safety conflict(s).`);
    for (const c of result.conflicts) io.err(`  ${c.predicate}: ${c.message}`);
    return 1;
  }

  const candidate = result.contract.air;
  if (candidate.operations.length === 0) {
    const diagnostic: GatewayDiagnostic = {
      level: "error",
      code: "gateway/no_operations",
      message:
        "The selected gateway API produced no callable operations. Confirm the selected API/export entry and ensure the gateway export contains at least one route.",
      coordinate: contract.location,
    };
    diagnostics.push(diagnostic);
    if (opts.json) {
      io.out(
        JSON.stringify(
          {
            vendor: opts.vendor,
            api: apiRef.id,
            contract,
            operations: { total: 0 },
            diagnostics,
            output: { created: false },
            receipt: { created: false },
          },
          null,
          2,
        ),
      );
    } else {
      io.err(`Gateway import stopped: [${diagnostic.code}] ${diagnostic.message}`);
      printDiagnostics(io, diagnostics);
    }
    return 1;
  }
  if (opts.spec && !gatewayUrl) {
    diagnostics.push({
      level: "error",
      code: "gateway/missing_runtime_coordinate",
      message:
        "No operator-attested public gateway base URL is available. Re-run with `--gateway-url <https://gateway.example/base>`.",
      coordinate: contract.location,
    });
  }
  const expectedGatewayAuth = imported.diagnostics.some(
    (d) => d.code === "gateway/auth_contract_incomplete",
  );
  if (
    opts.spec &&
    expectedGatewayAuth &&
    candidate.operations.some(
      (operation) => operation.auth.type === "none" || operation.auth.principal === "anonymous",
    )
  ) {
    diagnostics.push({
      level: "warning",
      code: "gateway/auth_contract_incomplete",
      message:
        "The gateway export indicates authentication, but the supplied contract still leaves at least one operation anonymous or without a credential scheme. Declare the IdP/security scheme, carrier, audience, and scopes before exposure.",
      coordinate: contract.location,
    });
  }

  const guard = gatewayGuardOverlay(candidate.operations, diagnostics, contract.location);
  if (guard) {
    result = await compileContract(source, [overlay, guard], {
      serviceId: opts.service,
      manifest,
    });
    if (result.status === "conflicted") {
      io.err(`Import conflicted: ${result.conflicts.length} unresolved safety conflict(s).`);
      for (const c of result.conflicts) io.err(`  ${c.predicate}: ${c.message}`);
      return 1;
    }
  }

  const air = result.contract.air;
  for (const diagnostic of air.diagnostics) {
    if (diagnostic.code !== BUDGET_WARNING_CODE && diagnostic.code !== BUDGET_WAIVED_CODE) {
      continue;
    }
    if (
      !diagnostics.some(
        (candidate) =>
          candidate.code === diagnostic.code && candidate.message === diagnostic.message,
      )
    ) {
      diagnostics.push({
        level: diagnostic.level,
        code: diagnostic.code,
        message: diagnostic.message,
      });
    }
  }
  if (gatewayUrl) {
    air.service.servers = [
      {
        url: gatewayUrl,
        description: "Operator-attested public API gateway endpoint",
      },
    ];
  }
  appendGatewayDiagnostics(air, diagnostics);
  const outDir = opts.out ?? join("generated", air.service.id);
  const bundle = generateBundle(air);
  const output = gatewayBundleManifest(bundle.files);
  const receipt = finalizeGatewayImportReceipt({
    schemaVersion: 1,
    receiptType: "anvil.gateway-import",
    selection: {
      vendor: adapter.kind,
      apiId: apiRef.id,
      export: {
        format: loaded.exportFormat,
        sha256: gatewaySha256(loaded.exportBytes),
        bytes: loaded.exportBytes.byteLength,
        storedAs: "raw/export.bin",
      },
      archiveEntry: loaded.archiveEntry,
    },
    inventory: { digest: snapshot.digest },
    contract: {
      provenance: contract,
      compilerSource: {
        snapshotId: source.snapshotId,
        sourceHash: source.sourceHash,
        entrypoint: source.entrypoint.path,
      },
    },
    runtime: gatewayUrl
      ? {
          gatewayUrl,
          attestation: "operator",
        }
      : undefined,
    lockedSource: lockedSourceReceipt,
    compilerInput,
    overlays: [
      receiptOverlay("gateway_policy", overlay),
      ...(guard ? [receiptOverlay("import_guard", guard)] : []),
    ],
    diagnostics,
    blockers: diagnostics.filter(blocksGatewayImport),
    output,
  });
  bundle.files["import.receipt.json"] = `${JSON.stringify(
    redactGatewayImportReceipt(receipt, { workspaceRoot: resolve(opts.root ?? ".") }),
    null,
    2,
  )}\n`;

  const store = receiptStore(opts);
  const workspaceRoot = resolve(opts.root ?? ".");
  // Persist the immutable receipt before making a new bundle live. A crash may
  // leave an unreferenced receipt, but can no longer leave a live bundle whose
  // receipt view has no backing record and whose prior version is hidden.
  const stored = await store.create(receipt, loaded.exportBytes);
  if (!stored.ok) {
    if (opts.json) {
      io.out(
        JSON.stringify(
          {
            vendor: opts.vendor,
            api: apiRef.id,
            receipt: {
              importId: receipt.importId,
              digest: receipt.digest,
              created: false,
              persisted: false,
            },
            output: { ok: false, installed: false, directory: resolve(outDir) },
            diagnostics: stored.diagnostics,
          },
          null,
          2,
        ),
      );
    } else {
      io.err(
        `Gateway import receipt ${receipt.importId} could not be persisted; output untouched.`,
      );
      for (const diagnostic of stored.diagnostics) {
        io.err(
          `  ${diagnostic.level}: [${diagnostic.code}] ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`,
        );
      }
    }
    return 1;
  }

  const installation = await prepareBundleInstall(
    outDir,
    bundle,
    receipt,
    store,
    workspaceRoot,
    opts.replaceDerived === true,
    deps,
  );
  if (!installation.ok) {
    if (opts.json) {
      io.out(
        JSON.stringify(
          {
            vendor: opts.vendor,
            api: apiRef.id,
            receipt: {
              importId: receipt.importId,
              digest: receipt.digest,
              directory: resolve(stored.dir),
              created: stored.created,
              persisted: true,
            },
            output: {
              ok: false,
              installed: false,
              directory: resolve(outDir),
            },
            diagnostics: installation.diagnostics,
          },
          null,
          2,
        ),
      );
    } else {
      io.err(
        `Gateway import ${receipt.importId} was recorded, but its output bundle could not be installed; the prior output remains untouched.`,
      );
      for (const diagnostic of installation.diagnostics) {
        io.err(
          `  ${diagnostic.level}: [${diagnostic.code}] ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`,
        );
      }
    }
    return 1;
  }

  const cleanup = installation.commit();
  const written = installation.written;

  const opaque = diagnostics.filter((d) => d.code.includes("opaque"));
  const generated = air.operations.filter((o) => o.state === "generated").length;
  const approved = air.operations.filter((o) => o.state === "approved").length;
  const review = air.operations.filter((o) => o.state === "review_required").length;
  const deprecated = air.operations.filter((o) => o.state === "deprecated").length;
  const blocked = air.operations.filter((o) => o.state === "blocked").length;
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
          output: {
            ok: true,
            installed: true,
            directory: installation.directory,
            retainedBackup: cleanup.retainedBackup,
            cleanupWarning: cleanup.warning,
          },
          operations: {
            total: air.operations.length,
            generated,
            approved,
            review_required: review,
            deprecated,
            blocked,
          },
          contract,
          receipt: {
            importId: receipt.importId,
            digest: receipt.digest,
            directory: resolve(stored.dir),
            created: stored.created,
            export: receipt.selection.export,
            inventoryDigest: receipt.inventory.digest,
            output: receipt.output,
            integrity: { ok: true },
          },
          source: {
            snapshotId: source.snapshotId,
            sourceHash: source.sourceHash,
            origin: source.origin,
            entrypoint: source.entrypoint,
            lock: locked,
            diagnostics: sourceDiagnostics,
          },
          opaque: opaque.map((d) => ({ code: d.code, message: d.message })),
          diagnostics,
        },
        null,
        2,
      ),
    );
    return diagnostics.some((d) => d.level === "error") ? 1 : 0;
  }
  io.out(
    `Imported ${apiRef.id} from the ${opts.vendor} estate → ${outDir} (${written.length} files).`,
  );
  io.out(
    `  operations: ${air.operations.length}  generated: ${generated}  approved: ${approved}  review_required: ${review}  deprecated: ${deprecated}  blocked: ${blocked}`,
  );
  io.out(
    `  contract: ${contract.kind}/${contract.fidelity} ${contract.format ?? "unknown"} @ ${contract.location.origin}${contract.location.pointer ? `#${contract.location.pointer}` : ""}`,
  );
  io.out(
    `  receipt: ${receipt.importId} (${receipt.digest}) → ${resolve(stored.dir)}${stored.created ? "" : " [already present]"}`,
  );
  if (cleanup.warning) io.err(`Warning: ${cleanup.warning}`);
  if (locked) {
    io.out(
      `  locked source: ${locked.snapshotId} ${locked.entrypoint} (${locked.sourceHash}) → ${locked.directory}`,
    );
  }
  if (opaque.length > 0) {
    io.out(
      `  ⚠ ${opaque.length} opaque polic${opaque.length === 1 ? "y" : "ies"} — the gateway rewrites traffic in ways the adapter cannot prove it understands; certification is blocked until they are reviewed:`,
    );
    printDiagnostics(io, opaque);
  }
  if (diagnostics.length > opaque.length) {
    io.out("Diagnostics:");
    printDiagnostics(
      io,
      diagnostics.filter((d) => !d.code.includes("opaque")),
    );
  }
  if (blocked > 0 && contract.fidelity === "route_only") {
    io.out(
      "  Recovery: supply the original contract with `--spec <openapi-or-swagger-path> [--root <workspace>]`; Anvil will lock it and reapply gateway policy by method/path.",
    );
  } else if (blocked > 0) {
    io.out("  Resolve the gateway diagnostics above before attempting approval or certification.");
  } else if (review > 0) {
    io.out(`  Run \`anvil inspect ${outDir}\` then \`anvil approve\` to expose more.`);
  }
  return diagnostics.some((d) => d.level === "error") ? 1 : 0;
}

async function runVerify(importId: string, opts: VerifyOptions, io: CliIO): Promise<number> {
  const receipt = await receiptStore(opts).verify(importId);
  let source = {
    checked: false,
    ok: true,
    snapshotId: undefined as string | undefined,
    diagnostics: [] as Array<{
      level: string;
      code: string;
      message: string;
      path?: string;
    }>,
  };
  let output = {
    checked: false,
    ok: true,
    bundle: opts.bundle ? resolve(opts.bundle) : undefined,
    diagnostics: [] as Array<{
      level: string;
      code: string;
      message: string;
      path?: string;
    }>,
  };

  if (receipt.receipt?.lockedSource) {
    const integrity = await sourceService(opts).validate(receipt.receipt.lockedSource.snapshotId);
    source = {
      checked: true,
      ok: integrity.ok,
      snapshotId: receipt.receipt.lockedSource.snapshotId,
      diagnostics: integrity.diagnostics,
    };
  }

  if (opts.bundle && receipt.receipt) {
    const bundleRoot = resolve(opts.bundle);
    const files = new Map<string, Uint8Array>();
    for (const expected of receipt.receipt.output.files) {
      const path = join(bundleRoot, expected.path);
      if (existsSync(path)) files.set(expected.path, readFileSync(path));
    }
    const verified = verifyGatewayImportOutput(receipt.receipt, files);
    const diagnostics = [...verified.diagnostics];
    try {
      const bundleFiles = readBundleDir(bundleRoot);
      let lifecycle = {
        paths: new Set(Object.keys(bundleFiles).filter((path) => isGatewayLifecycleArtifact(path))),
        diagnostics: [] as BundleInstallDiagnostic[],
      };
      try {
        lifecycle = gatewayLifecycleArtifacts(
          bundleFiles,
          airFromJson(bundleFiles["air.json"] ?? ""),
        );
      } catch (err) {
        if (Object.keys(bundleFiles).some((path) => path.startsWith("targets/"))) {
          lifecycle.diagnostics.push({
            level: "error",
            code: "gateway_receipt/unverified_target",
            message: `Canonical AIR cannot validate target artifacts: ${err instanceof Error ? err.message : String(err)}`,
            path: "air.json",
          });
        }
      }
      diagnostics.push(...lifecycle.diagnostics);
      diagnostics.push(
        ...exactFileSetDiagnostics(
          listBundleFiles(bundleRoot),
          [...receipt.receipt.output.files.map((file) => file.path), "import.receipt.json"].sort(),
          lifecycle.paths,
        ),
      );
    } catch (err) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/output_unreadable",
        message: err instanceof Error ? err.message : String(err),
        path: bundleRoot,
      });
    }
    const bundleReceiptPath = join(bundleRoot, "import.receipt.json");
    if (!existsSync(bundleReceiptPath)) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/bundle_receipt_missing",
        message: "Generated bundle has no import.receipt.json.",
        path: "import.receipt.json",
      });
    } else {
      try {
        const bundled = GatewayImportReceiptView.parse(
          JSON.parse(readFileSync(bundleReceiptPath, "utf8")),
        );
        if (bundled.lineage.status === "stale") {
          diagnostics.push({
            level: "error",
            code: "gateway_receipt/output_lineage_stale",
            message: bundled.lineage.reason,
            path: "import.receipt.json",
          });
        }
        const expectedView = redactGatewayImportReceipt(receipt.receipt, {
          workspaceRoot: resolve(opts.root ?? "."),
        });
        if (JSON.stringify(bundled) !== JSON.stringify(expectedView)) {
          diagnostics.push({
            level: "error",
            code: "gateway_receipt/bundle_receipt_mismatch",
            message: "Bundle receipt view does not match the stored private receipt projection.",
            path: "import.receipt.json",
          });
        }
      } catch (err) {
        diagnostics.push({
          level: "error",
          code: "gateway_receipt/bundle_receipt_unparseable",
          message: `Bundle import.receipt.json is not valid JSON: ${(err as Error).message}`,
          path: "import.receipt.json",
        });
      }
    }
    output = {
      checked: true,
      ok: diagnostics.length === 0,
      bundle: bundleRoot,
      diagnostics,
    };
  }

  const ok = receipt.ok && source.ok && output.ok;
  const report = {
    ok,
    importId,
    receipt: {
      ok: receipt.ok,
      directory: receipt.dir ? resolve(receipt.dir) : undefined,
      digest: receipt.receipt?.digest,
      export: receipt.receipt?.selection.export,
      diagnostics: receipt.diagnostics,
    },
    source,
    output,
  };
  if (opts.json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(
      `${ok ? "Verified" : "FAILED"} gateway import ${importId}${receipt.dir ? ` at ${resolve(receipt.dir)}` : ""}.`,
    );
    for (const section of [report.receipt, source, output]) {
      for (const diagnostic of section.diagnostics) {
        io.out(
          `  ${diagnostic.level}: [${diagnostic.code}] ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`,
        );
      }
    }
    if (source.checked) {
      io.out(`  locked source: ${source.snapshotId} ${source.ok ? "intact" : "changed"}`);
    }
    if (output.checked) {
      io.out(`  output bundle: ${output.bundle} ${output.ok ? "intact" : "changed"}`);
    }
  }
  return ok ? 0 : 1;
}
