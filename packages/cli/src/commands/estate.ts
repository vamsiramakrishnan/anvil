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
  writeFileSync,
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
  type GatewayIdentityEvidence,
  type GatewayImportReceipt,
  type GatewayImportReceiptDraft,
  GatewayImportReceiptView,
  type GatewayPolicyOverlay,
  gatewayAgentServiceId,
  gatewayBundleManifest,
  gatewayCapabilityReviewInput,
  gatewayDeploymentNamespace,
  gatewayImportIdentity,
  gatewayImportIdentitySlug,
  gatewayManifestDigest,
  gatewayOperationRef,
  gatewaySha256,
  isGatewayLifecycleArtifact,
  KongGatewayAdapter,
  MulesoftGatewayAdapter,
  makeOverlay,
  parseManifest,
  readArchive,
  reconcileGatewayIdentity,
  redactGatewayImportReceipt,
  resolveGatewayApiSelection,
  sniffArchiveFormat,
  verifyGatewayImportOutput,
  verifyGatewayImportOutputManifest,
  type Wso2ApiProject,
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
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { CliIO } from "../io.js";
import {
  loadWso2ApictlDirectory,
  loadWso2ApictlZip,
  Wso2ApictlCollectionError,
} from "../wso2-apictl.js";
import type { CommandContext } from "./context.js";
import {
  buildEstateAdoptionPlan,
  buildEstateSelectionTemplate,
  EstateAdoptionPlanError,
  type EstateSelectionDocument,
  type EstateSelectionEntry,
  parseEstateAdoptionPlan,
  parseEstateSelection,
  renderEstateAdoptionPlan,
} from "./estate-adoption.js";
import { buildEstateAudit } from "./estate-audit.js";
import { registerEstateSupport } from "./estate-support.js";
import {
  blocksGatewayImport,
  dedupeGatewayDiagnostics,
  gatewayDiagnosticAppliesToSelection,
} from "./gateway-diagnostic-policy.js";
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

/** Common offline connection plus WSO2's native multi-project collection seam. */
interface EstateConnection extends GatewayConnection {
  config: string;
  origin?: string;
  apiProjects?: Wso2ApiProject[];
  collectionDiagnostics?: GatewayDiagnostic[];
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
    .summary("Assess explicitly tiered gateway inputs and adopt selected APIs.")
    .description(
      "Run `estate support [vendor]` first: WSO2 supports native estates, Kong one native declarative state, and Apigee/MuleSoft/API Connect normalized interchange. Reads an adapter-supported offline gateway artifact: a bare document, a ZIP/JAR decoded through the hardened archive harness, or a native WSO2 apictl collection directory. The container reader is not a general native-artifact translator; run `estate audit` and read the gateway skill reference for each adapter's exact input boundary. " +
        "`inventory`, `audit`, and `plan` assess the estate without exposing it; `import` resolves one exact API/version/revision/environment coordinate into a receipt-bound bundle. Risky operations remain unexposed. Review accepted semantics in a supplemental manifest and re-import; receipt-bound output cannot be approved in place.",
    );

  registerEstateSupport(estate, ctx);

  annotate(
    estate
      .command("connect")
      .summary("Probe the chosen vendor adapter and confirm whether the export is understandable.")
      .argument(
        "<export>",
        "vendor export: a config file, ZIP/JAR archive, or WSO2 apictl collection directory",
      )
      .requiredOption("--vendor <vendor>", `vendor (${VENDOR_LIST})`)
      .option("--entry <path>", "archive entry holding the config, when the archive has several")
      .option(
        "--gateway-id <id>",
        "stable gateway control-plane/org/instance id included in the probe digest (default unscoped)",
      )
      .option("--json", "emit the connect report as JSON")
      .action(async (exportPath: string, opts: ConnectOptions) => {
        ctx.code = await runConnect(exportPath, opts, ctx.io);
      }),
    { mutates: false },
  );

  annotate(
    estate
      .command("inventory")
      .summary("List the APIs in a gateway export without compiling anything.")
      .argument(
        "<export>",
        "vendor export: a config file, ZIP/JAR archive, or WSO2 apictl collection directory",
      )
      .requiredOption("--vendor <vendor>", `gateway vendor (${VENDOR_LIST})`)
      .option("--entry <path>", "archive entry holding the config, when the archive has several")
      .option(
        "--gateway-id <id>",
        "stable gateway control-plane/org/instance id included in the inventory digest (default unscoped)",
      )
      .option("--query <text>", "filter the view by API id or name (case-insensitive)")
      .option("--owner <owner>", "filter the view by exact API owner")
      .option("--lifecycle <state>", "filter the view by exact lifecycle state")
      .option("--limit <count>", "maximum API rows in the view (default 50)", "50")
      .option("--all", "return every matching API instead of applying --limit")
      .option("--summary", "emit counts and diagnostics without per-API rows")
      .option("--json", "emit the inventory snapshot as JSON")
      .action(async (exportPath: string, opts: InventoryOptions) => {
        ctx.code = await runInventory(exportPath, opts, ctx.io);
      }),
    { mutates: false },
  );

  annotate(
    estate
      .command("audit")
      .summary("Audit a whole gateway estate without compiling or exposing any API.")
      .description(
        "Builds a deterministic, machine-readable adoption report over the complete inventory: adapter capability gaps, contract fidelity, route ambiguity, authentication evidence, opaque policy findings, accountable owners, and exact next actions. A completed audit exits zero by default even when it finds blockers; use --check to make it a CI gate.",
      )
      .argument(
        "<export>",
        "vendor export: a config file, ZIP/JAR archive, or WSO2 apictl collection directory",
      )
      .requiredOption("--vendor <vendor>", `gateway vendor (${VENDOR_LIST})`)
      .option("--entry <path>", "archive entry holding the config, when the archive has several")
      .option(
        "--gateway-id <id>",
        "stable gateway control-plane/org/instance id included in the audit baseline (default unscoped)",
      )
      .option("--json", "emit the complete audit report as one JSON document")
      .option("--check", "exit non-zero when findings meet --fail-on")
      .option(
        "--fail-on <level>",
        "CI threshold: blocked | review-required (used with --check)",
        "blocked",
      )
      .action(async (exportPath: string, opts: AuditOptions) => {
        ctx.code = await runAudit(exportPath, opts, ctx.io);
      }),
    { mutates: false },
  );

  annotate(
    estate
      .command("plan")
      .summary("Build a resumable, baseline-aware adoption plan for a gateway estate.")
      .description(
        "Inventories and audits the complete adapter-supported document, then emits one deterministic adoption-plan artifact for bulk triage while import remains API-by-API. Use --init-selection to create an overwrite-safe coordinate queue whose rows all start in triage; reviewers may mix deterministic_only, agent_assisted, and manual_review per API. The plan captures explicit triage/selected/deferred decisions, accountable owners, dispositions, baseline fingerprints, owner workstreams, stage status, and concrete next actions. Ready rows include an import command template with every reviewed coordinate filled; replace only <export> with the local path. Optional CASE/distill investigation lanes are proposal-only; inspect, lint, receipt-bound import, and verify remain authoritative. Pass a reviewed prior plan with --baseline and --check to fail on re-export, adapter, finding, API, or selection drift.",
      )
      .argument(
        "<export>",
        "vendor export: an adapter-supported config/ZIP/JAR or WSO2 apictl collection directory",
      )
      .requiredOption("--vendor <vendor>", `gateway vendor (${VENDOR_LIST})`)
      .option("--entry <path>", "archive entry holding the config, when the archive has several")
      .option(
        "--gateway-id <id>",
        "stable gateway control-plane/org/instance id used by every strict import command",
      )
      .option(
        "--selection <path>",
        "versioned YAML/JSON selection file with API decisions, intent, owner, contract, and gateway URL",
      )
      .option(
        "--init-selection <path>",
        "write a new coordinate-aware triage selection file (never auto-selects; refuses existing files)",
      )
      .option(
        "--select <id>",
        "select one exact inventory API id (repeatable; ambiguous revisions/environments require --selection)",
        collectOption,
        [],
      )
      .option(
        "--baseline <path>",
        "reviewed prior adoption-plan JSON; selections are inherited when no new selection is supplied",
      )
      .option("--out <path>", "write the complete deterministic adoption-plan JSON here")
      .option(
        "--check",
        "require --baseline and exit non-zero when source, API, finding, adapter, or selection state changed",
      )
      .option("--json", "emit the complete adoption plan as JSON instead of the bounded human view")
      .action(async (exportPath: string, opts: PlanOptions) => {
        ctx.code = await runPlan(exportPath, opts, ctx.io);
      }),
    { mutates: true },
  );

  annotate(
    estate
      .command("import")
      .summary("Import one API from a gateway export and compile it into a bundle.")
      .argument(
        "<export>",
        "vendor export: a config file, ZIP/JAR archive, or WSO2 apictl collection directory",
      )
      .requiredOption("--vendor <vendor>", `gateway vendor (${VENDOR_LIST})`)
      .option("--api <id>", "API id from `estate inventory` (optional when the estate has one)")
      .option(
        "--gateway-id <id>",
        "stable gateway control-plane/org/instance id when the export does not carry one",
      )
      .option(
        "--strict-identity",
        "require --gateway-id and block unproven required issuer/audience/carrier/principal dimensions",
      )
      .option(
        "--environment <id>",
        "deployment environment; required when the selected API exists in several",
      )
      .option(
        "--api-version <version>",
        "semantic API version; required when a gateway exposes several versions independently of revisions",
      )
      .option(
        "--revision <revision>",
        "gateway revision; required when the selected API has several (for native WSO2: working-copy or revision-N)",
      )
      .option("--entry <path>", "archive entry holding the config, when the archive has several")
      .option(
        "--spec <path>",
        "original OpenAPI/Swagger contract; lock it and apply gateway policies instead of compiling route-only synthesis",
      )
      .option(
        "--attest-spec-override <reason>",
        "explicit WSO2 attestation when --spec cannot exactly match one embedded Definitions contract; recorded in the private receipt",
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
      .option(
        "--service <id>",
        "reviewed agent-facing service id (default derives from gateway/API/revision/environment)",
      )
      .option(
        "--out <dir>",
        "bundle output directory (default generated/<service-id>/<environment-revision-identity>)",
      )
      .option(
        "--replace-derived",
        "replace verified derived output for the same stable gateway coordinate when approval made it stale or export/inventory evidence changed; verified later lifecycle artifacts are explicitly discarded",
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
  gatewayId?: string;
  json?: boolean;
  query?: string;
  owner?: string;
  lifecycle?: string;
  limit?: string;
  all?: boolean;
  summary?: boolean;
}
interface AuditOptions extends InventoryOptions {
  check?: boolean;
  failOn?: string;
}
interface PlanOptions {
  vendor: string;
  entry?: string;
  gatewayId?: string;
  selection?: string;
  initSelection?: string;
  select?: string[];
  baseline?: string;
  out?: string;
  check?: boolean;
  json?: boolean;
}
interface ImportOptions extends InventoryOptions {
  api?: string;
  apiVersion?: string;
  gatewayId?: string;
  strictIdentity?: boolean;
  environment?: string;
  revision?: string;
  spec?: string;
  attestSpecOverride?: string;
  manifest?: string;
  gatewayUrl?: string;
  root?: string;
  service?: string;
  out?: string;
  replaceDerived?: boolean;
  json?: boolean;
}
interface ConnectOptions extends Pick<InventoryOptions, "entry" | "gatewayId" | "json"> {
  vendor: string;
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

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function invalidGatewayId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) {
    return "Invalid --gateway-id: expected a non-empty stable control-plane/org/instance id.";
  }
  if (normalized.toLowerCase() === "unscoped") {
    return "Invalid --gateway-id: 'unscoped' is reserved for compatibility lineage whose gateway identity is not proven; provide the real stable control-plane/org/instance id.";
  }
  return undefined;
}

function pathsAlias(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  if (resolvedLeft === resolvedRight) return true;
  if (!existsSync(resolvedLeft) || !existsSync(resolvedRight)) return false;
  const leftStat = statSync(resolvedLeft);
  const rightStat = statSync(resolvedRight);
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
}

/** Resolve the vendor adapter or explain the valid set. */
function adapterFor(
  vendor: string,
  io: CliIO,
  json = false,
): GatewayAdapter<EstateConnection> | undefined {
  const make = VENDORS[vendor];
  if (!make) {
    const message = `Unknown --vendor '${vendor}'. Use: ${VENDOR_LIST}.`;
    if (json) {
      io.out(
        JSON.stringify(
          {
            schemaVersion: 1,
            reportType: "anvil.gateway-estate-error",
            code: "estate/unknown_vendor",
            message,
          },
          null,
          2,
        ),
      );
    } else {
      io.err(message);
    }
  }
  return make?.();
}

const CONFIG_EXTENSIONS = [".json", ".yaml", ".yml", ".xml"];
const UNSUPPORTED_NATIVE_ARTIFACT_CODE = "gateway/unsupported_native_artifact";

function unsupportedNativeArtifactMessage(
  vendor: string,
  origin: string,
  options: { text?: string; archiveEntries?: readonly string[]; selectedEntry?: string } = {},
): string | undefined {
  const normalizedEntries = (options.archiveEntries ?? []).map((path) =>
    path.replaceAll("\\", "/").toLowerCase(),
  );
  const selected = options.selectedEntry?.replaceAll("\\", "/").toLowerCase();
  const relevantEntries =
    selected === undefined
      ? normalizedEntries
      : normalizedEntries.filter((path) => path === selected);
  const text = options.text;

  if (
    vendor === "apigee" &&
    (relevantEntries.some(
      (path) =>
        path.includes("/apiproxy/proxies/") ||
        path.startsWith("apiproxy/proxies/") ||
        path.includes("/apiproxy/targets/") ||
        path.startsWith("apiproxy/targets/"),
    ) ||
      (text !== undefined &&
        /<(?:APIProxy|ProxyEndpoint|TargetEndpoint)\b/u.test(text.slice(0, 16_384))))
  ) {
    return `[${UNSUPPORTED_NATIVE_ARTIFACT_CODE}] Native Apigee apiproxy XML detected in '${origin}'. Archive safety validation is not semantic translation: this adapter currently accepts only Anvil's normalized proxies/products interchange document. No native proxy policy, flow, product, or deployment semantics were imported. Run \`anvil estate support apigee\` for the exact boundary.`;
  }

  if (
    vendor === "mulesoft" &&
    (relevantEntries.some(
      (path) =>
        basename(path) === "mule-artifact.json" ||
        path.includes("/src/main/mule/") ||
        path.startsWith("src/main/mule/"),
    ) ||
      basename(origin).toLowerCase() === "mule-artifact.json")
  ) {
    return `[${UNSUPPORTED_NATIVE_ARTIFACT_CODE}] Native Mule application JAR/project structure detected in '${origin}'. The MuleSoft estate adapter currently accepts only Anvil's normalized APIs/resources/policies interchange document; it does not decode Mule XML, DataWeave, Exchange assets, or API Manager instance state. Run \`anvil estate support mulesoft\` for the exact boundary.`;
  }

  if (vendor === "api_connect" && text !== undefined) {
    try {
      const document = parseYaml(text) as unknown;
      if (document !== null && typeof document === "object" && !Array.isArray(document)) {
        const nativeApi = Object.hasOwn(document, "x-ibm-configuration");
        const nativeProduct =
          Object.hasOwn(document, "product") &&
          Object.hasOwn(document, "apis") &&
          !Array.isArray((document as Record<string, unknown>).apis);
        if (nativeApi || nativeProduct) {
          const shape = nativeApi
            ? "OpenAPI x-ibm-configuration"
            : "Product YAML with referenced APIs";
          return `[${UNSUPPORTED_NATIVE_ARTIFACT_CODE}] Native IBM API Connect ${shape} detected in '${origin}'. An OpenAPI document may be supplied separately as a formal --spec, but the API Connect estate adapter currently accepts only Anvil's normalized APIs/products/plans interchange document and does not bind native Products or decode the native assembly. Run \`anvil estate support api_connect\` for the exact boundary.`;
        }
      }
    } catch {
      // The adapter will report the ordinary parse diagnostic when no native
      // root signature can be established safely.
    }
  }

  return undefined;
}

interface LoadedEstateConfig {
  config: string;
  origin: string;
  /** Verbatim outer container bytes, even when config came from a ZIP member. */
  exportBytes: Uint8Array;
  /** Expanded semantic identity for native collections, independent of ZIP metadata. */
  semanticDigest?: string;
  exportFormat: "text" | "zip" | "wso2_apictl_collection";
  archiveEntry?: string;
  apiProjects?: Wso2ApiProject[];
  collectionDiagnostics?: GatewayDiagnostic[];
}

function portableGatewayOrigin(loaded: LoadedEstateConfig): string {
  const digest = loaded.semanticDigest ?? gatewaySha256(loaded.exportBytes);
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
  vendor: string,
  entry: string | undefined,
  io: CliIO,
  onError: (message: string) => void = (message) => io.err(message),
): LoadedEstateConfig | undefined {
  let pathStat: ReturnType<typeof statSync>;
  try {
    pathStat = statSync(exportPath);
  } catch (err) {
    onError(`Cannot read '${exportPath}': ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  if (pathStat.isDirectory()) {
    if (vendor !== "wso2") {
      onError(
        `'${exportPath}' is a directory. Native collection directories are currently supported only for --vendor wso2.`,
      );
      return undefined;
    }
    if (entry) {
      onError(
        "`--entry` does not select an API from a WSO2 apictl collection; inventory the collection and use --api/--api-version/--revision/--environment.",
      );
      return undefined;
    }
    try {
      const collection = loadWso2ApictlDirectory(exportPath);
      return {
        config: "",
        origin: exportPath,
        exportBytes: collection.exportBytes,
        semanticDigest: collection.semanticDigest,
        exportFormat: "wso2_apictl_collection",
        apiProjects: collection.projects,
        collectionDiagnostics: collection.diagnostics,
      };
    } catch (error) {
      onError(
        error instanceof Wso2ApictlCollectionError
          ? `[${error.code}] ${error.message}`
          : `Cannot read WSO2 apictl collection '${exportPath}': ${String(error)}`,
      );
      return undefined;
    }
  }
  if (!pathStat.isFile()) {
    onError(`'${exportPath}' is not a regular file or supported collection directory.`);
    return undefined;
  }

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(exportPath);
  } catch (err) {
    onError(`Cannot read '${exportPath}': ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }

  const format = sniffArchiveFormat(bytes);
  if (format === "tar" || format === "gzip") {
    onError(
      `'${exportPath}' is a ${format} container, which has no decoder yet — supply a ZIP/JAR export or the extracted config file.`,
    );
    return undefined;
  }

  if (format !== "zip") {
    const text = decodeArchiveText({ path: exportPath, bytes });
    if (!text.ok) {
      onError(`'${exportPath}' is not valid UTF-8 text (and not a ZIP archive).`);
      return undefined;
    }
    const unsupported = unsupportedNativeArtifactMessage(vendor, exportPath, {
      text: text.text,
    });
    if (unsupported) {
      onError(unsupported);
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
      onError(`Archive refused: ${err.message}`);
      return undefined;
    }
    throw err;
  }
  for (const d of result.diagnostics) {
    onError(`${d.level}: [${d.code}] ${d.message}${d.path ? ` (${d.path})` : ""}`);
  }
  if (!result.ok) {
    onError("Archive rejected by the safety battery; nothing was imported.");
    return undefined;
  }

  const unsupportedArchive = unsupportedNativeArtifactMessage(vendor, exportPath, {
    archiveEntries: result.files.map((file) => file.path),
    selectedEntry: entry,
  });
  if (unsupportedArchive) {
    onError(unsupportedArchive);
    return undefined;
  }
  if (vendor === "api_connect" && entry === undefined) {
    for (const file of result.files.filter((candidate) =>
      CONFIG_EXTENSIONS.some((extension) => candidate.path.toLowerCase().endsWith(extension)),
    )) {
      const decoded = decodeArchiveText(file);
      if (!decoded.ok) continue;
      const unsupported = unsupportedNativeArtifactMessage(vendor, `${exportPath}!${file.path}`, {
        text: decoded.text,
      });
      if (unsupported) {
        onError(unsupported);
        return undefined;
      }
    }
  }

  if (
    vendor === "wso2" &&
    entry === undefined &&
    result.files.some((file) => basename(file.path).toLowerCase() === "api.yaml")
  ) {
    try {
      const project = loadWso2ApictlZip(bytes, basename(exportPath));
      return {
        config: "",
        origin: exportPath,
        exportBytes: project.exportBytes,
        semanticDigest: project.semanticDigest,
        exportFormat: "zip",
        apiProjects: project.projects,
        collectionDiagnostics: project.diagnostics,
      };
    } catch (error) {
      onError(
        error instanceof Wso2ApictlCollectionError
          ? `[${error.code}] ${error.message}`
          : `Cannot read WSO2 apictl archive '${exportPath}': ${String(error)}`,
      );
      return undefined;
    }
  }

  const candidates = entry
    ? result.files.filter((f) => f.path === entry)
    : result.files.filter((f) => CONFIG_EXTENSIONS.some((ext) => f.path.endsWith(ext)));
  if (candidates.length === 0) {
    onError(
      entry
        ? `Archive has no entry '${entry}'. Entries: ${result.files.map((f) => f.path).join(", ")}`
        : `Archive has no config-like entry (${CONFIG_EXTENSIONS.join("/")}). Use --entry <path>.`,
    );
    return undefined;
  }
  if (candidates.length > 1) {
    onError(
      `Archive has ${candidates.length} config-like entries — pick one with --entry <path>:\n  ${candidates.map((f) => f.path).join("\n  ")}`,
    );
    return undefined;
  }
  const file = candidates[0];
  if (!file) return undefined;
  const text = decodeArchiveText(file);
  if (!text.ok) {
    onError(`Archive entry '${file.path}' is not valid UTF-8 text.`);
    return undefined;
  }
  const unsupported = unsupportedNativeArtifactMessage(vendor, `${exportPath}!${file.path}`, {
    text: text.text,
    archiveEntries: result.files.map((candidate) => candidate.path),
    selectedEntry: file.path,
  });
  if (unsupported) {
    onError(unsupported);
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

function loadEstateForCommand(
  exportPath: string,
  vendor: string,
  entry: string | undefined,
  json: boolean | undefined,
  io: CliIO,
): LoadedEstateConfig | undefined {
  const errors: string[] = [];
  const loaded = loadEstateConfig(
    exportPath,
    vendor,
    entry,
    io,
    json ? (message) => errors.push(message) : undefined,
  );
  if (!loaded && json) {
    const unsupported = errors.some((message) =>
      message.includes(`[${UNSUPPORTED_NATIVE_ARTIFACT_CODE}]`),
    );
    io.out(
      JSON.stringify(
        {
          schemaVersion: 1,
          reportType: "anvil.gateway-estate-error",
          code: unsupported ? UNSUPPORTED_NATIVE_ARTIFACT_CODE : "estate/export_unreadable",
          message: errors.at(-1) ?? `Cannot read '${exportPath}'.`,
          diagnostics: errors,
        },
        null,
        2,
      ),
    );
  }
  return loaded;
}

function estateConnection(id: string, loaded: LoadedEstateConfig): EstateConnection {
  return {
    id,
    config: loaded.config,
    origin: portableGatewayOrigin(loaded),
    ...(loaded.apiProjects ? { apiProjects: loaded.apiProjects } : {}),
    ...(loaded.collectionDiagnostics
      ? { collectionDiagnostics: loaded.collectionDiagnostics }
      : {}),
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

/**
 * Bridge structured gateway identity evidence into durable import diagnostics.
 * Outside strict mode an absent evidence set stays a visible adapter/audit debt.
 * Strict mode also reconciles an empty set so authenticated operations cannot
 * turn missing issuer/audience/carrier proof into permission to expose.
 */
export function gatewayIdentityDiagnostics(
  operations: readonly Operation[],
  evidence: readonly GatewayIdentityEvidence[],
  options: { strict?: boolean } = {},
): GatewayDiagnostic[] {
  if (evidence.length === 0 && !options.strict) return [];
  return operations.flatMap((operation) => {
    const report = reconcileGatewayIdentity(operation.auth, evidence, {
      operationRefs: operationKeys(operation),
    });
    return report.findings.map((finding): GatewayDiagnostic => {
      const strictConflict =
        options.strict === true &&
        (strictIdentityDimensions(operation).has(finding.dimension) ||
          finding.state === "missing_contract");
      return {
        level: finding.severity === "error" || strictConflict ? "error" : "warning",
        code:
          finding.state === "contradictory"
            ? "gateway/identity_contradictory"
            : `gateway/identity_${finding.state}`,
        message: `${operation.id}: ${finding.message} ${finding.remediation}${
          strictConflict ? " Strict identity mode requires this dimension before exposure." : ""
        }`,
        ...(finding.coordinates[0] ? { coordinate: finding.coordinates[0] } : {}),
      };
    });
  });
}

function strictIdentityDimensions(
  operation: Operation,
): Set<"type" | "principal" | "issuer" | "audience" | "carrier" | "scopes"> {
  const required = new Set<"type" | "principal" | "issuer" | "audience" | "carrier" | "scopes">([
    "type",
    "principal",
  ]);
  switch (operation.auth.type) {
    case "api_key":
    case "basic":
    case "custom_header":
      required.add("carrier");
      break;
    case "jwt_bearer":
    case "oauth2_client_credentials":
    case "oauth2_authorization_code":
    case "oauth2_on_behalf_of":
      required.add("issuer");
      required.add("audience");
      required.add("carrier");
      break;
    case "workload_identity":
      required.add("audience");
      required.add("carrier");
      break;
  }
  if (operation.auth.scopes.length > 0) required.add("scopes");
  return required;
}

function operationKeys(operation: Operation): string[] {
  const route =
    operation.sourceRef.method && operation.sourceRef.path
      ? gatewayOperationRef(operation.sourceRef.method, operation.sourceRef.path)
      : undefined;
  return [operation.id, operation.canonicalName, operation.sourceRef.operationId, route].filter(
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
      const priorIdentity = priorReceipt.receipt?.selection.identity;
      const candidateIdentity = receipt.selection.identity;
      if (
        !priorIdentity ||
        !candidateIdentity ||
        priorIdentity.digest !== candidateIdentity.digest
      ) {
        const describe = (identity: GatewayImportReceipt["selection"]["identity"]): string =>
          identity
            ? `${identity.vendor}/${identity.gatewayId}/${identity.apiId}/${identity.environment}/${identity.revision} (${identity.digest})`
            : "legacy receipt without a first-class gateway identity";
        return {
          ok: false,
          diagnostics: [
            {
              level: "error",
              code: "gateway_receipt/output_identity_collision",
              message:
                `Existing output belongs to ${describe(priorIdentity)}, but this import is ${describe(candidateIdentity)}. ` +
                "A different vendor/gateway/API/environment/revision/export lineage may never replace this directory. Omit --out for the collision-safe default, or choose a new --out directory.",
              path: directory,
            },
          ],
        };
      }
      if (priorIdentity.lineageDigest !== candidateIdentity.lineageDigest && !replaceDerived) {
        return {
          ok: false,
          diagnostics: [
            {
              level: "error",
              code: "gateway_receipt/evidence_transition_requires_replace",
              message:
                `The stable gateway coordinate is unchanged (${candidateIdentity.digest}), but export/inventory evidence changed from ${priorIdentity.lineageDigest} to ${candidateIdentity.lineageDigest}. ` +
                "Review the estate diff, then re-run with --replace-derived to accept this verified lineage transition. A changed unrelated API will not change the default output path.",
              path: directory,
            },
          ],
        };
      }
      const existingFiles = readBundleDir(directory);
      if (priorView.lineage.status === "bound" && priorReceipt.receipt) {
        const priorOutputFiles = new Map<string, Uint8Array>();
        for (const expected of priorReceipt.receipt.output.files) {
          const path = join(directory, expected.path);
          if (existsSync(path)) priorOutputFiles.set(expected.path, readFileSync(path));
        }
        const priorOutputIntegrity = verifyGatewayImportOutput(
          priorReceipt.receipt,
          priorOutputFiles,
        );
        if (!priorOutputIntegrity.ok) {
          return {
            ok: false,
            diagnostics: [
              {
                level: "error",
                code: "gateway_receipt/prior_output_changed",
                message:
                  "Existing receipt-bound output no longer matches its immutable manifest; refusing a lineage transition or replacement.",
                path: directory,
              },
              ...priorOutputIntegrity.diagnostics,
            ],
          };
        }
      }
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
  const gatewayIdError = invalidGatewayId(opts.gatewayId);
  if (gatewayIdError) {
    if (opts.json) {
      io.out(
        JSON.stringify(
          {
            schemaVersion: 1,
            reportType: "anvil.gateway-estate-inventory-error",
            code: "estate/invalid_gateway_id",
            message: gatewayIdError,
          },
          null,
          2,
        ),
      );
    } else {
      io.err(gatewayIdError);
    }
    return 1;
  }
  const adapter = adapterFor(opts.vendor, io, opts.json);
  if (!adapter) return 1;
  const loaded = loadEstateForCommand(exportPath, opts.vendor, opts.entry, opts.json, io);
  if (!loaded) return 1;

  const snapshot = await adapter.inventory(
    estateConnection(opts.gatewayId?.trim() || "unscoped", loaded),
    {},
  );
  const parsedLimit = Number(opts.limit ?? "50");
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 10_000) {
    const message = `Invalid --limit '${opts.limit}': expected an integer from 1 to 10000.`;
    if (opts.json) {
      io.out(
        JSON.stringify(
          {
            schemaVersion: 1,
            reportType: "anvil.gateway-estate-inventory-error",
            code: "estate/invalid_limit",
            message,
          },
          null,
          2,
        ),
      );
    } else {
      io.err(message);
    }
    return 1;
  }
  const query = opts.query?.toLocaleLowerCase();
  const matched = snapshot.apis.filter(
    (api) =>
      (!query ||
        api.id.toLocaleLowerCase().includes(query) ||
        api.name.toLocaleLowerCase().includes(query)) &&
      (!opts.owner || api.owner === opts.owner) &&
      (!opts.lifecycle || api.lifecycle === opts.lifecycle),
  );
  const selected = opts.all ? matched : matched.slice(0, parsedLimit);
  const summary = {
    apis: snapshot.apis.length,
    matched: matched.length,
    returned: opts.summary ? 0 : selected.length,
    routes: matched.reduce((total, api) => total + api.routes.length, 0),
    fullContracts: matched.filter((api) => api.contract?.fidelity === "full").length,
    routeOnlyContracts: matched.filter((api) => api.contract?.fidelity === "route_only").length,
    missingContracts: matched.filter((api) => !api.contract || api.contract.fidelity === "missing")
      .length,
    authenticationUnproven: matched.filter((api) => !api.authSummary).length,
    diagnostics: {
      error: snapshot.diagnostics.filter((diagnostic) => diagnostic.level === "error").length,
      warning: snapshot.diagnostics.filter((diagnostic) => diagnostic.level === "warning").length,
      info: snapshot.diagnostics.filter((diagnostic) => diagnostic.level === "info").length,
    },
  };
  if (opts.json) {
    const filtered =
      opts.summary ||
      Boolean(opts.query || opts.owner || opts.lifecycle || opts.all) ||
      opts.limit !== "50";
    io.out(
      JSON.stringify(
        opts.summary
          ? {
              schemaVersion: 1,
              reportType: "anvil.gateway-estate-inventory-summary",
              vendor: opts.vendor,
              inventoryDigest: snapshot.digest,
              summary,
              diagnostics: snapshot.diagnostics,
            }
          : filtered
            ? {
                ...snapshot,
                apis: selected,
                view: {
                  sourceApis: snapshot.apis.length,
                  matched: matched.length,
                  returned: selected.length,
                  filters: {
                    query: opts.query,
                    owner: opts.owner,
                    lifecycle: opts.lifecycle,
                  },
                },
              }
            : snapshot,
        null,
        2,
      ),
    );
  } else {
    io.out(
      `${snapshot.apis.length} API(s) in ${opts.vendor} estate ${loaded.origin}; ${matched.length} match the current view.`,
    );
    io.out(
      `  routes: ${summary.routes} · contracts: ${summary.fullContracts} full, ${summary.routeOnlyContracts} route-only, ${summary.missingContracts} missing · auth unproven: ${summary.authenticationUnproven}`,
    );
    if (!opts.summary) {
      for (const api of selected) {
        const routes = api.routes.length ? ` · ${api.routes.length} route(s)` : "";
        const auth = api.authSummary ? ` · ${api.authSummary}` : "";
        const coordinate =
          (api.revision
            ? ` · API version ${api.version ?? "unversioned"} · gateway revision ${api.revision}`
            : ` · revision/version ${api.version && api.version !== "0.0.0" ? api.version : "unversioned"}`) +
          ` · environment ${api.environmentIds.join(", ") || "unscoped"}`;
        const contract = api.contract
          ? ` · contract ${api.contract.kind}/${api.contract.fidelity} @ ${api.contract.location.origin}${api.contract.location.pointer ? `#${api.contract.location.pointer}` : ""}`
          : " · contract provenance unavailable";
        const formalDefinitions = (api.artifacts ?? []).filter(
          (artifact) => artifact.role === "formal_definition",
        );
        const definition =
          opts.vendor !== "wso2"
            ? ""
            : formalDefinitions.length === 1
              ? ` · embedded definition ${formalDefinitions[0]?.origin}`
              : formalDefinitions.length > 1
                ? ` · embedded definitions ambiguous (${formalDefinitions.length}): ${formalDefinitions.map((artifact) => artifact.origin).join(", ")}`
                : " · embedded definition missing";
        io.out(`  ${api.id} — ${api.name}${coordinate}${routes}${auth}${contract}${definition}`);
      }
      if (selected.length < matched.length) {
        io.out(
          `  … ${matched.length - selected.length} more matching API(s); use --all, filters, or --json.`,
        );
      }
    }
    if (snapshot.diagnostics.length > 0) {
      io.out(
        `Diagnostics: ${summary.diagnostics.error} error · ${summary.diagnostics.warning} warning · ${summary.diagnostics.info} info`,
      );
      if (!opts.summary) {
        const diagnosticLimit = opts.all ? snapshot.diagnostics.length : 20;
        printDiagnostics(io, snapshot.diagnostics.slice(0, diagnosticLimit));
        if (snapshot.diagnostics.length > diagnosticLimit) {
          io.out(
            `  … ${snapshot.diagnostics.length - diagnosticLimit} more diagnostic(s); use --json for all.`,
          );
        }
      }
    }
  }
  return snapshot.diagnostics.some((d) => d.level === "error") ? 1 : 0;
}

async function runConnect(
  exportPath: string,
  opts: ConnectOptions,
  io: CliIO,
): Promise<number> {
  const gatewayIdError = invalidGatewayId(opts.gatewayId);
  if (gatewayIdError) {
    if (opts.json) {
      io.out(
        JSON.stringify(
          {
            schemaVersion: 1,
            reportType: "anvil.gateway-estate-connect-error",
            code: "estate/invalid_gateway_id",
            message: gatewayIdError,
          },
          null,
          2,
        ),
      );
    } else {
      io.err(gatewayIdError);
    }
    return 1;
  }
  const adapter = adapterFor(opts.vendor, io, opts.json);
  if (!adapter) return 1;
  const loaded = loadEstateForCommand(exportPath, opts.vendor, opts.entry, opts.json, io);
  if (!loaded) return 1;

  const probe = await adapter.probe(
    estateConnection(opts.gatewayId?.trim() || "unscoped", loaded),
    {},
  );
  if (opts.json) {
    const diagnostics = dedupeGatewayDiagnostics(probe.diagnostics);
    const summary = {
      errors: diagnostics.filter((diagnostic) => diagnostic.level === "error").length,
      warnings: diagnostics.filter((diagnostic) => diagnostic.level === "warning").length,
      infos: diagnostics.filter((diagnostic) => diagnostic.level === "info").length,
    };
    io.out(
      JSON.stringify(
        {
          schemaVersion: 1,
          reportType: "anvil.gateway-estate-connect",
          vendor: opts.vendor,
          gatewayId: opts.gatewayId?.trim() || "unscoped",
          reachable: probe.reachable,
          protocolVersion: probe.protocolVersion,
          capabilities: probe.capabilities,
          diagnostics: diagnostics.map((diagnostic) => ({
            level: diagnostic.level,
            code: diagnostic.code,
            message: diagnostic.message,
            path: coordinateText(diagnostic),
          })),
          summary,
          exportDigest: gatewaySha256(loaded.exportBytes),
        },
        null,
        2,
      ),
    );
  } else {
    io.out(
      `Gateway probe for ${opts.vendor}: ${probe.reachable ? "reachable" : "unreachable"} ` +
        `via ${opts.gatewayId?.trim() || "unscoped"}${loaded.archiveEntry ? ` (entry ${loaded.archiveEntry})` : ""}`,
    );
    if (probe.protocolVersion) {
      io.out(`  protocol: ${probe.protocolVersion}`);
    }
    io.out(
      `  capabilities: ${Object.entries(probe.capabilities)
        .map(
          ([capability, value]) =>
            `${capability}=${typeof value === "boolean" ? (value ? "yes" : "no") : value}`,
        )
        .join(", ")}`,
    );
    io.out(`  diagnostics: ${probe.diagnostics.length}`);
    if (probe.diagnostics.length > 0) {
      printDiagnostics(io, probe.diagnostics);
    }
  }
  return probe.reachable ? 0 : 1;
}

async function runAudit(exportPath: string, opts: AuditOptions, io: CliIO): Promise<number> {
  if (!["blocked", "review-required"].includes(opts.failOn ?? "blocked")) {
    const message = `Invalid --fail-on '${opts.failOn}'. Use: blocked | review-required.`;
    if (opts.json) {
      io.out(
        JSON.stringify(
          {
            schemaVersion: 1,
            reportType: "anvil.gateway-estate-audit-error",
            code: "estate/invalid_fail_on",
            message,
          },
          null,
          2,
        ),
      );
    } else {
      io.err(message);
    }
    return 1;
  }
  const gatewayIdError = invalidGatewayId(opts.gatewayId);
  if (gatewayIdError) {
    if (opts.json) {
      io.out(
        JSON.stringify(
          {
            schemaVersion: 1,
            reportType: "anvil.gateway-estate-audit-error",
            code: "estate/invalid_gateway_id",
            message: gatewayIdError,
          },
          null,
          2,
        ),
      );
    } else {
      io.err(gatewayIdError);
    }
    return 1;
  }
  const adapter = adapterFor(opts.vendor, io, opts.json);
  if (!adapter) return 1;
  const loaded = loadEstateForCommand(exportPath, opts.vendor, opts.entry, opts.json, io);
  if (!loaded) return 1;
  const snapshot = await adapter.inventory(
    estateConnection(opts.gatewayId?.trim() || "unscoped", loaded),
    {},
  );
  const report = buildEstateAudit(adapter, snapshot);
  if (opts.json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(
      `Estate audit: ${report.vendor} · ${report.summary.apis} APIs · ${report.summary.routes} routes · gate ${report.gate}`,
    );
    io.out(`  inventory: ${report.inventoryDigest}`);
    io.out(
      `  adoption: ${report.summary.candidates} candidate · ${report.summary.needsEvidence} need evidence · ${report.summary.blocked} blocked`,
    );
    io.out(
      `  contracts: ${report.summary.fullContracts} full · ${report.summary.routeOnlyContracts} route-only · ${report.summary.missingContracts} missing`,
    );
    io.out(
      `  findings: ${report.summary.findings.blocking} blocking · ${report.summary.findings.warning} warning · ${report.summary.findings.info} info`,
    );
    if (report.adapter.limitations.length > 0) {
      io.out(`  adapter limitations: ${report.adapter.limitations.join(", ")}`);
    }
    const material = report.findings.filter((finding) => finding.severity !== "info");
    if (material.length > 0) {
      io.out(`Findings${material.length > 20 ? " (first 20)" : ""}:`);
      for (const finding of material.slice(0, 20)) {
        io.out(
          `  ${finding.severity}: [${finding.code}] ${finding.scope.kind} ${finding.scope.id} — ${finding.message}`,
        );
        io.out(`    owner: ${finding.owner} · next: ${finding.action}`);
      }
    }
    if (report.nextActions.length > 0) {
      io.out("Next actions:");
      for (const action of report.nextActions) io.out(`  - ${action}`);
    }
    io.out("Use --json for the complete per-API report and every finding.");
  }
  if (!opts.check) return 0;
  return opts.failOn === "review-required"
    ? report.gate === "pass"
      ? 0
      : 1
    : report.gate === "blocked"
      ? 1
      : 0;
}

function emitPlanError(
  io: CliIO,
  json: boolean | undefined,
  code: string,
  message: string,
): number {
  if (json) {
    io.out(
      JSON.stringify(
        {
          schemaVersion: 1,
          reportType: "anvil.gateway-estate-adoption-plan-error",
          code,
          message,
        },
        null,
        2,
      ),
    );
  } else {
    io.err(message);
  }
  return 1;
}

function writeNewEstateSelection(destination: string, selection: EstateSelectionDocument): void {
  const absolute = resolve(destination);
  mkdirSync(dirname(absolute), { recursive: true });
  try {
    writeFileSync(absolute, stringifyYaml(selection, { lineWidth: 0 }), {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new EstateAdoptionPlanError(
        "estate/selection_overwrite",
        `Refusing to overwrite existing selection file '${absolute}'. Choose a new path or edit the versioned file deliberately.`,
      );
    }
    throw error;
  }
}

async function runPlan(exportPath: string, opts: PlanOptions, io: CliIO): Promise<number> {
  if (opts.check && !opts.baseline) {
    return emitPlanError(
      io,
      opts.json,
      "estate/baseline_required",
      "`anvil estate plan --check` requires --baseline <reviewed-plan.json>.",
    );
  }
  const gatewayIdError = invalidGatewayId(opts.gatewayId);
  if (gatewayIdError) {
    return emitPlanError(io, opts.json, "estate/invalid_gateway_id", gatewayIdError);
  }
  if (
    opts.initSelection &&
    (opts.selection !== undefined || (opts.select?.length ?? 0) > 0 || opts.baseline !== undefined)
  ) {
    return emitPlanError(
      io,
      opts.json,
      "estate/selection_init_conflict",
      "`--init-selection` starts a new triage queue and cannot be combined with --selection, --select, or --baseline.",
    );
  }
  if (opts.initSelection && existsSync(resolve(opts.initSelection))) {
    return emitPlanError(
      io,
      opts.json,
      "estate/selection_overwrite",
      `Refusing to overwrite existing selection file '${resolve(opts.initSelection)}'. Choose a new path or edit the versioned file deliberately.`,
    );
  }
  if (opts.initSelection && opts.out && resolve(opts.initSelection) === resolve(opts.out)) {
    return emitPlanError(
      io,
      opts.json,
      "estate/output_path_collision",
      "`--init-selection` and `--out` must use different files.",
    );
  }
  if (opts.out && opts.baseline && pathsAlias(opts.out, opts.baseline)) {
    return emitPlanError(
      io,
      opts.json,
      "estate/baseline_overwrite",
      "`--out` must not overwrite the reviewed --baseline; write a candidate plan and promote it only after review.",
    );
  }

  const adapter = adapterFor(opts.vendor, io, opts.json);
  if (!adapter) return 1;
  const loaded = loadEstateForCommand(exportPath, opts.vendor, opts.entry, opts.json, io);
  if (!loaded) return 1;

  try {
    const prior = opts.baseline
      ? parseEstateAdoptionPlan(JSON.parse(readFileSync(opts.baseline, "utf8")))
      : undefined;
    const effectiveGatewayId =
      opts.gatewayId?.trim() ||
      (prior?.gateway.source === "operator" ? prior.gateway.id : "unscoped");
    let selectedFromFile: EstateSelectionEntry[] | undefined;
    if (opts.selection) {
      const parsed = parseEstateSelection(parseYaml(readFileSync(opts.selection, "utf8")));
      selectedFromFile = parsed.apis;
    }
    const selectedFromCli =
      opts.select && opts.select.length > 0
        ? parseEstateSelection({
            schemaVersion: 1,
            apis: opts.select.map((id) => ({ id, decision: "selected" })),
          }).apis
        : [];
    const snapshot = await adapter.inventory(estateConnection(effectiveGatewayId, loaded), {});
    const audit = buildEstateAudit(adapter, snapshot);
    const initializedSelection = opts.initSelection
      ? buildEstateSelectionTemplate(snapshot)
      : undefined;
    const hasCurrentSelection =
      initializedSelection !== undefined ||
      selectedFromFile !== undefined ||
      selectedFromCli.length > 0;
    const selectionEntries = hasCurrentSelection
      ? [...(initializedSelection?.apis ?? []), ...(selectedFromFile ?? []), ...selectedFromCli]
      : undefined;
    const plan = buildEstateAdoptionPlan(snapshot, audit, {
      prior,
      selectionEntries,
      selectionSource: opts.selection || opts.initSelection ? "file" : "cli",
      gatewayId: effectiveGatewayId === "unscoped" ? undefined : effectiveGatewayId,
      exportEntry: opts.entry,
    });
    const serialized = `${JSON.stringify(plan, null, 2)}\n`;
    if (opts.initSelection && initializedSelection) {
      writeNewEstateSelection(opts.initSelection, initializedSelection);
    }
    if (opts.out) {
      const destination = resolve(opts.out);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, serialized, "utf8");
    }
    if (opts.json) {
      io.out(serialized.trimEnd());
    } else {
      for (const line of renderEstateAdoptionPlan(plan)) io.out(line);
      if (opts.initSelection) {
        io.out(`Wrote triage-only selection file to ${resolve(opts.initSelection)}.`);
      }
      if (opts.out) io.out(`Wrote complete adoption plan to ${resolve(opts.out)}.`);
    }
    return opts.check && plan.change.status !== "unchanged" ? 1 : 0;
  } catch (error) {
    if (error instanceof EstateAdoptionPlanError) {
      return emitPlanError(io, opts.json, error.code, error.message);
    }
    const source = opts.selection ?? opts.initSelection ?? opts.baseline;
    return emitPlanError(
      io,
      opts.json,
      "estate/adoption_plan_failed",
      source
        ? `Cannot build estate adoption plan from '${source}': ${error instanceof Error ? error.message : String(error)}`
        : `Cannot build estate adoption plan: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function emitEstateImportError(
  io: CliIO,
  json: boolean | undefined,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): number {
  if (json) {
    io.out(
      JSON.stringify(
        {
          schemaVersion: 1,
          reportType: "anvil.gateway-estate-import-error",
          code,
          message,
          ...details,
          output: { created: false },
          receipt: { created: false },
        },
        null,
        2,
      ),
    );
  } else {
    io.err(`[${code}] ${message}`);
  }
  return 1;
}

async function runImport(
  exportPath: string,
  opts: ImportOptions,
  io: CliIO,
  deps: Pick<CommandContext["deps"], "cleanupGatewayBundleBackup"> = {},
): Promise<number> {
  const specOverrideReason = opts.attestSpecOverride?.trim();
  if (opts.attestSpecOverride !== undefined) {
    if (!opts.spec) {
      return emitEstateImportError(
        io,
        opts.json,
        "gateway/spec_override_without_spec",
        "`--attest-spec-override` requires `--spec`; there is no supplied contract to attest.",
      );
    }
    if (opts.vendor !== "wso2") {
      return emitEstateImportError(
        io,
        opts.json,
        "gateway/spec_override_wrong_vendor",
        "`--attest-spec-override` is currently defined only for WSO2 native Definitions lineage.",
      );
    }
    if (!specOverrideReason || specOverrideReason.length > 2_000) {
      return emitEstateImportError(
        io,
        opts.json,
        "gateway/invalid_spec_override_attestation",
        "`--attest-spec-override <reason>` requires a non-empty reason of at most 2,000 characters.",
      );
    }
  }
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

  const adapter = adapterFor(opts.vendor, io, opts.json);
  if (!adapter) return 1;
  const loaded = loadEstateForCommand(exportPath, opts.vendor, opts.entry, opts.json, io);
  if (!loaded) return 1;

  const explicitGatewayId = opts.gatewayId?.trim();
  const gatewayIdError = invalidGatewayId(opts.gatewayId);
  if (gatewayIdError) {
    if (opts.json) {
      io.out(
        JSON.stringify(
          {
            schemaVersion: 1,
            reportType: "anvil.gateway-estate-import-error",
            code: "gateway_selection/invalid_gateway_id",
            message: gatewayIdError,
          },
          null,
          2,
        ),
      );
    } else {
      io.err(gatewayIdError);
    }
    return 1;
  }
  if (opts.strictIdentity && !explicitGatewayId) {
    const message =
      "`--strict-identity` requires `--gateway-id <id>` because this offline export does not prove its control-plane identity.";
    if (opts.json) {
      io.out(
        JSON.stringify(
          {
            schemaVersion: 1,
            reportType: "anvil.gateway-estate-import-error",
            code: "gateway_selection/gateway_id_required",
            message,
          },
          null,
          2,
        ),
      );
    } else {
      io.err(message);
    }
    return 1;
  }
  const gatewayId = explicitGatewayId ?? "unscoped";
  const connection = estateConnection(gatewayId, loaded);
  const snapshot = await adapter.inventory(connection, {});
  const globalInventoryErrors = snapshot.diagnostics.filter(
    (diagnostic) => diagnostic.level === "error" && diagnostic.subject === undefined,
  );
  if (globalInventoryErrors.length > 0) {
    io.err("The gateway inventory is ambiguous or invalid; nothing was imported.");
    printDiagnostics(io, globalInventoryErrors);
    return 1;
  }
  const resolvedSelection = resolveGatewayApiSelection(snapshot.apis, {
    apiId: opts.api,
    apiVersion: opts.apiVersion,
    revision: opts.revision,
    environment: opts.environment,
  });
  if (!resolvedSelection.ok) {
    if (opts.json) {
      io.out(
        JSON.stringify(
          {
            schemaVersion: 1,
            reportType: "anvil.gateway-estate-import-error",
            ...resolvedSelection.failure,
          },
          null,
          2,
        ),
      );
    } else {
      io.err(`[${resolvedSelection.failure.code}] ${resolvedSelection.failure.message}`);
      if (resolvedSelection.failure.candidates.length > 0) {
        io.err(`Candidates:\n  ${resolvedSelection.failure.candidates.join("\n  ")}`);
      }
    }
    return 1;
  }
  const { api: apiRef, apiVersion, revision, environment } = resolvedSelection.selection;
  const selectedCoordinate = {
    id: apiRef.id,
    ...(apiVersion ? { apiVersion } : {}),
    revision,
    environment,
    artifacts: apiRef.artifacts,
  };
  const applicableInventoryDiagnostics = snapshot.diagnostics.filter((diagnostic) =>
    gatewayDiagnosticAppliesToSelection(diagnostic, selectedCoordinate),
  );
  const selectedInventoryErrors = applicableInventoryDiagnostics.filter(
    (diagnostic) => diagnostic.level === "error",
  );
  if (selectedInventoryErrors.length > 0) {
    io.err(
      `The selected gateway API coordinate '${apiRef.id}${apiVersion ? `:${apiVersion}` : ""}@${revision} [${environment}]' is ambiguous or invalid; nothing was imported.`,
    );
    printDiagnostics(io, selectedInventoryErrors);
    return 1;
  }
  let sourceArtifact: { origin: string; digest: string } | undefined;
  if (adapter.kind === "wso2" && loaded.apiProjects !== undefined) {
    const projectContainers = (apiRef.artifacts ?? []).filter(
      (artifact) => artifact.kind === "container" && artifact.role === "api_project",
    );
    if (projectContainers.length !== 1) {
      return emitEstateImportError(
        io,
        opts.json,
        "wso2/ambiguous_selected_project_lineage",
        `Selected native WSO2 API '${apiRef.id}' has ${projectContainers.length} ` +
          "api_project container records; exactly one reviewed source artifact is required before extraction.",
        {
          selection: {
            id: apiRef.id,
            ...(apiVersion ? { apiVersion } : {}),
            revision,
            environment,
          },
        },
      );
    }
    const projectContainer = projectContainers[0];
    if (projectContainer) {
      sourceArtifact = {
        origin: projectContainer.origin,
        digest: projectContainer.digest,
      };
    }
  }
  const serviceId =
    opts.service ??
    gatewayAgentServiceId({
      vendor: adapter.kind,
      gatewayId,
      apiId: apiRef.id,
      ...(apiVersion ? { apiVersion } : {}),
      revision,
      environment,
    });

  const imported = await adapter.extractApi(
    connection,
    {
      id: apiRef.id,
      name: apiRef.name,
      version: apiVersion ?? revision,
      ...(apiVersion ? { revision } : {}),
      environmentId: environment,
      ...(sourceArtifact ? { sourceArtifact } : {}),
    },
    {},
  );
  let source = imported.source;
  let overlay = imported.overlay;
  let contract = imported.contract;
  let diagnostics = dedupeGatewayDiagnostics(
    [...applicableInventoryDiagnostics, ...imported.diagnostics].filter((diagnostic) =>
      gatewayDiagnosticAppliesToSelection(diagnostic, selectedCoordinate),
    ),
  );
  if (!explicitGatewayId) {
    diagnostics.push({
      level: "warning",
      code: "gateway/unscoped_gateway_identity",
      message:
        "This export does not prove which gateway control plane it came from. The receipt records gatewayIdSource=unscoped; pass --gateway-id <stable-id> (or use --strict-identity) for estate-safe lineage.",
      coordinate: contract.location,
    });
  }
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
  let formalDefinitionLineage: GatewayImportReceiptDraft["contract"]["formalDefinitionLineage"];
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

    if (adapter.kind === "wso2") {
      const formalDefinitions = (imported.artifacts ?? [])
        .filter((artifact) => artifact.role === "formal_definition")
        .sort(
          (left, right) =>
            left.origin.localeCompare(right.origin) ||
            left.path.localeCompare(right.path) ||
            left.digest.localeCompare(right.digest),
        );
      const suppliedFile = added.snapshot.files.find(
        (file) => file.path === bound.source?.entrypoint.path,
      );
      if (!suppliedFile) {
        return emitEstateImportError(
          io,
          opts.json,
          "gateway/formal_definition_source_missing",
          "The locked supplied contract entrypoint is absent from its own source manifest; no lineage can be established.",
        );
      }
      const supplied = {
        path: suppliedFile.path,
        digest: `sha256:${suppliedFile.sha256.replace(/^sha256:/, "")}`,
      };
      const exactMatch =
        formalDefinitions.length === 1 && formalDefinitions[0]?.digest === supplied.digest;
      if (exactMatch && specOverrideReason) {
        return emitEstateImportError(
          io,
          opts.json,
          "gateway/unnecessary_spec_override",
          "The supplied contract already exactly matches the selected embedded WSO2 definition. Remove `--attest-spec-override`; no override is needed or recorded.",
          { formalDefinitions, supplied },
        );
      }
      if (exactMatch) {
        formalDefinitionLineage = {
          mode: "embedded_digest_match",
          candidates: formalDefinitions,
          supplied,
        };
      } else if (specOverrideReason) {
        formalDefinitionLineage = {
          mode: "operator_override",
          candidates: formalDefinitions,
          supplied,
          override: {
            attestation: "operator",
            reason: specOverrideReason,
          },
        };
      } else {
        const code =
          formalDefinitions.length === 0
            ? "gateway/formal_definition_missing"
            : formalDefinitions.length > 1
              ? "gateway/formal_definition_ambiguous"
              : "gateway/formal_definition_digest_mismatch";
        const message =
          formalDefinitions.length === 0
            ? "The selected WSO2 project has no validated embedded Definitions OpenAPI/Swagger contract to bind to the supplied --spec. Review the project and, only for a legitimate external contract, repeat with `--attest-spec-override <reason>`."
            : formalDefinitions.length > 1
              ? `The selected WSO2 project has ${formalDefinitions.length} validated embedded Definitions contracts. Anvil will not infer which one is authoritative; select deliberately and repeat with \`--attest-spec-override <reason>\`.`
              : `The supplied contract digest ${supplied.digest} does not match the selected embedded WSO2 definition ${formalDefinitions[0]?.digest}. Route compatibility is not byte lineage. Supply the exact extracted member or explicitly attest a legitimate override with \`--attest-spec-override <reason>\`.`;
        return emitEstateImportError(io, opts.json, code, message, {
          formalDefinitions,
          supplied,
          selection: {
            id: apiRef.id,
            ...(apiVersion ? { apiVersion } : {}),
            revision,
            environment,
          },
        });
      }
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
    serviceId,
    manifest,
  });
  if (result.status === "conflicted") {
    io.err(`Import conflicted: ${result.conflicts.length} unresolved safety conflict(s).`);
    for (const c of result.conflicts) io.err(`  ${c.predicate}: ${c.message}`);
    return 1;
  }

  const candidate = result.contract.air;
  if (
    candidate.service.environment !== undefined &&
    candidate.service.environment !== environment
  ) {
    const message =
      `The manifest declares service.environment '${candidate.service.environment}', ` +
      `but the selected gateway coordinate is '${environment}'. Refusing to generate deployment and credential defaults for the wrong environment.`;
    if (opts.json) {
      io.out(
        JSON.stringify(
          {
            schemaVersion: 1,
            reportType: "anvil.gateway-estate-import-error",
            code: "gateway_selection/environment_conflict",
            message,
          },
          null,
          2,
        ),
      );
    } else {
      io.err(message);
    }
    return 1;
  }
  candidate.service.environment = environment;
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
  const structuredIdentityEvidence =
    imported.identityEvidence && imported.identityEvidence.length > 0
      ? imported.identityEvidence
      : (apiRef.identityEvidence ?? []);
  // A route-only synthesized contract intentionally has no authoritative auth
  // model. Comparing its anonymous placeholder to gateway auth evidence would
  // manufacture a contradiction; the existing auth_contract_incomplete guard
  // already blocks every operation until the real contract is supplied.
  if (contract.fidelity === "full") {
    diagnostics.push(
      ...gatewayIdentityDiagnostics(candidate.operations, structuredIdentityEvidence, {
        strict: opts.strictIdentity === true,
      }),
    );
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
    (diagnostic) =>
      diagnostic.code === "gateway/auth_contract_incomplete" &&
      gatewayDiagnosticAppliesToSelection(diagnostic, selectedCoordinate),
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
      serviceId,
      manifest,
    });
    if (result.status === "conflicted") {
      io.err(`Import conflicted: ${result.conflicts.length} unresolved safety conflict(s).`);
      for (const c of result.conflicts) io.err(`  ${c.predicate}: ${c.message}`);
      return 1;
    }
  }

  const air = result.contract.air;
  air.service.environment = environment;
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
  const exportDigest = gatewaySha256(loaded.exportBytes);
  const importIdentity = gatewayImportIdentity({
    vendor: adapter.kind,
    gatewayId: snapshot.gateway.id,
    gatewayIdSource: explicitGatewayId ? "operator" : "unscoped",
    apiId: apiRef.id,
    ...(apiVersion ? { apiVersion } : {}),
    serviceId: air.service.id,
    environment,
    revision,
    exportDigest,
    inventoryDigest: snapshot.digest,
  });
  const outDir =
    opts.out ?? join("generated", air.service.id, gatewayImportIdentitySlug(importIdentity));
  const bundle = generateBundle(air, {
    deploymentNamespace: gatewayDeploymentNamespace(importIdentity),
  });
  const output = gatewayBundleManifest(bundle.files);
  const receipt = finalizeGatewayImportReceipt({
    schemaVersion: 1,
    receiptType: "anvil.gateway-import",
    selection: {
      vendor: adapter.kind,
      apiId: apiRef.id,
      identity: importIdentity,
      export: {
        format: loaded.exportFormat,
        sha256: exportDigest,
        bytes: loaded.exportBytes.byteLength,
        storedAs: "raw/export.bin",
      },
      archiveEntry: loaded.archiveEntry,
      ...(imported.artifacts && imported.artifacts.length > 0
        ? { artifacts: imported.artifacts }
        : {}),
    },
    inventory: { digest: snapshot.digest },
    contract: {
      provenance: contract,
      compilerSource: {
        snapshotId: source.snapshotId,
        sourceHash: source.sourceHash,
        entrypoint: source.entrypoint.path,
      },
      formalDefinitionLineage,
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
              identity: importIdentity,
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
              identity: importIdentity,
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
            identity: importIdentity,
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
    blocked > 0
      ? `Created a guarded bundle for ${apiRef.id} from the ${opts.vendor} estate → ${outDir} (${written.length} files); no blocked operation is exposed.`
      : `Imported ${apiRef.id} from the ${opts.vendor} estate → ${outDir} (${written.length} files).`,
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
  io.out(
    `  identity: ${importIdentity.gatewayId} / ${importIdentity.apiId}${importIdentity.apiVersion ? `:${importIdentity.apiVersion}` : ""} / ${importIdentity.environment} / ${importIdentity.revision} (${importIdentity.digest})`,
  );
  io.out(`  evidence lineage: ${importIdentity.lineageDigest}`);
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
    io.out(`  Run \`anvil inspect ${outDir}\`, then record reviewed semantics and`);
    io.out(
      "  operation states in a supplemental manifest and re-run this estate import with --manifest.",
    );
    io.out(
      "  Do not approve receipt-backed output in place: changing it makes immutable import lineage stale.",
    );
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
