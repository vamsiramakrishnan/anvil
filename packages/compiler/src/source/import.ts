/**
 * Layer 0 discovery — how a filesystem target becomes a source graph. Two
 * shapes of import share one pipeline:
 *
 *   explicit entrypoints  `anvil source add a.yaml b.yaml` — each named file
 *                         is an entrypoint; every LOCAL $ref reachable from
 *                         them is captured alongside.
 *   directory import      `anvil source add specs/` — every *.yaml/yml/json
 *                         (hidden, generated/, and .anvil paths skipped) is
 *                         probed; files declaring `openapi:`/`swagger:` become
 *                         entrypoints, their $ref graphs are unioned, and
 *                         unrelated YAML/JSON is excluded.
 *
 * Reference resolution is deliberately a small explicit walker instead of
 * Scalar's loader: the loader dereferences and bundles (mutating document
 * shape), while Layer 0 must capture verbatim bytes, know exactly which files
 * were touched, and enforce the escape policy below. The walker is ~60 lines
 * and does only that.
 *
 * Safety policy: the import root is canonicalized via realpath; every
 * discovered file is realpath-resolved and must stay inside the root
 * (`source/path_escape` otherwise) — symlinks are never followed outside it.
 * Remote/URL refs are recorded as external, never fetched.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { glob } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { detectProtocolFormat } from "../protocols/index.js";
import { findAll, parseXml, type XmlElement } from "../protocols/xml.js";
import {
  decodeUtf8,
  detectDeclaredFormat,
  parseSourceText,
  syntaxForPath,
  unparseableDiagnostic,
} from "./detect.js";
import { computeSourceHash, type SourceInputFile, sortByPath } from "./hash.js";
import type {
  EntrypointFormat,
  SourceDiagnostic,
  SourceEntrypoint,
  SourceFileRole,
  SpecSyntax,
} from "./model.js";

/** A captured file: verbatim bytes plus its place in the source graph. */
export interface ImportedFile extends SourceInputFile {
  role: SourceFileRole;
  syntax?: SpecSyntax;
}

export interface SourceImportResult {
  /** The canonical (realpath) import root; absent when nothing was readable. */
  rootDir?: string;
  /** Path-sorted captured files. Empty means nothing could be read. */
  files: ImportedFile[];
  entrypoints: SourceEntrypoint[];
  diagnostics: SourceDiagnostic[];
  /** Content hash over `files`; absent when nothing was captured. */
  sourceHash?: string;
}

/** How a source graph gets read. The service depends on this, not on `fs`. */
export interface SourceImporter {
  import(targets: string[]): Promise<SourceImportResult>;
}

/** Extensions a directory import probes; explicit entrypoints may be anything. */
const SPEC_EXTENSIONS = [
  "yaml",
  "yml",
  "json",
  "graphql",
  "gql",
  "graphqls",
  "proto",
  "wsdl",
  "xsd",
  "xml",
];

/** XSD schema files are XML supporting files, never YAML and never entrypoints. */
function isXsdPath(path: string): boolean {
  return path.toLowerCase().endsWith(".xsd");
}

/** Directory segments a directory import never descends into or captures. */
function skippedSegment(segment: string): boolean {
  return segment.startsWith(".") || segment === "generated";
}

export class FilesystemSourceImporter implements SourceImporter {
  async import(targets: string[]): Promise<SourceImportResult> {
    const diagnostics: SourceDiagnostic[] = [];
    if (targets.length === 0) {
      return {
        files: [],
        entrypoints: [],
        diagnostics: [{ level: "error", code: "source/empty", message: "No import target given." }],
      };
    }

    const present: string[] = [];
    for (const target of targets) {
      if (existsSync(target)) present.push(target);
      else {
        diagnostics.push({
          level: "error",
          code: "source/not_found",
          message: `No such file or directory: ${target}`,
        });
      }
    }
    if (present.length === 0) return { files: [], entrypoints: [], diagnostics };

    const directories = present.filter((t) => statSync(t).isDirectory());
    if (directories.length > 0 && present.length > 1) {
      diagnostics.push({
        level: "error",
        code: "source/invalid_target",
        message: "Import either one directory or explicit entrypoint files, not a mixture.",
      });
      return { files: [], entrypoints: [], diagnostics };
    }

    const state = new ImportState(diagnostics);
    if (directories.length === 1) {
      await importDirectory(state, realpathSync(directories[0] as string));
    } else {
      importEntrypoints(state, present);
    }

    const files = sortByPath(state.captured());
    return {
      rootDir: state.root,
      files,
      entrypoints: sortByPath(state.entrypoints),
      diagnostics,
      sourceHash: files.length > 0 ? computeSourceHash(files) : undefined,
    };
  }
}

/* --------------------------------- pipeline -------------------------------- */

/** Everything one import accumulates, keyed by canonical snapshot path. */
class ImportState {
  root = "";
  entrypoints: SourceEntrypoint[] = [];
  private files = new Map<string, ImportedFile>();
  constructor(readonly diagnostics: SourceDiagnostic[]) {}

  has(path: string): boolean {
    return this.files.has(path);
  }
  add(file: ImportedFile): void {
    this.files.set(file.path, file);
  }
  captured(): ImportedFile[] {
    return [...this.files.values()];
  }
}

/** One probed file: verbatim bytes plus whatever decoding/parsing observed. */
interface Probe {
  path: string;
  bytes: Uint8Array;
  syntax?: SpecSyntax;
  doc?: unknown;
  /** A non-REST protocol format detected from the file's path/content. */
  protocol?: { format: EntrypointFormat; version: string };
  diagnostics: SourceDiagnostic[];
}

/** Read and parse one file without recording anything yet. */
function probeFile(root: string, path: string): Probe {
  const bytes = readFileSync(join(root, path));
  const decoded = decodeUtf8(bytes);
  if ("error" in decoded) {
    return {
      path,
      bytes,
      diagnostics: [{ level: "error", code: "source/invalid_utf8", path, message: decoded.error }],
    };
  }
  // Non-REST protocols (GraphQL/proto/WSDL) are not YAML/JSON documents, so
  // detect them from path+content and capture them verbatim without a YAML
  // parse — a `.proto` or `.graphql` file must not be reported as broken YAML.
  const protocol = detectProtocolFormat(path, decoded.text);
  if (protocol) {
    return { path, bytes, protocol, diagnostics: [] };
  }
  // XSD schema documents get the same verbatim bypass: they are XML the WSDL
  // adapter parses at compile time, and a YAML probe would misreport them as
  // broken YAML (`source/unparseable`). They are supporting files, never
  // entrypoints, so no protocol claim is recorded.
  if (isXsdPath(path)) {
    return { path, bytes, diagnostics: [] };
  }
  const syntax = syntaxForPath(path);
  const parsed = parseSourceText(decoded.text);
  if (parsed.errors.length > 0) {
    return {
      path,
      bytes,
      syntax,
      diagnostics: parsed.errors.map((e) => unparseableDiagnostic(path, e)),
    };
  }
  return { path, bytes, syntax, doc: parsed.doc, diagnostics: [] };
}

/** Record a probe into the snapshot with its diagnostics and graph role. */
function capture(state: ImportState, probe: Probe, role: SourceFileRole): void {
  if (state.has(probe.path)) return;
  state.diagnostics.push(...probe.diagnostics);
  state.add({ path: probe.path, bytes: probe.bytes, syntax: probe.syntax, role });
}

/** Explicit entrypoints: the named files, plus their reachable local refs. */
function importEntrypoints(state: ImportState, targets: string[]): void {
  // Canonicalize before deriving the root so symlinked targets cannot smuggle
  // the root somewhere the real files do not live.
  const real = [...new Set(targets.map((t) => realpathSync(t)))];
  state.root = commonDirectory(real.map((f) => dirname(f)));
  for (const abs of real) {
    const path = toPosix(relative(state.root, abs));
    const probe = probeFile(state.root, path);
    const detected =
      probe.protocol ?? (probe.doc === undefined ? undefined : detectDeclaredFormat(probe.doc));
    if (detected) {
      state.entrypoints.push({ path, format: detected.format, version: detected.version });
      capture(state, probe, "entrypoint");
      // Protocol sources are single-document; only OpenAPI/Swagger have $refs —
      // except WSDL, whose import/include locations span files the way $refs do.
      if (probe.doc !== undefined) walkRefs(state, path, probe.doc);
      if (probe.protocol?.format === "wsdl") walkXmlImportsFromProbe(state, probe);
    } else {
      if (probe.diagnostics.length === 0) {
        state.diagnostics.push({
          level: "info",
          code: "source/no_declared_format",
          path,
          message: "Not a recognized OpenAPI/Swagger document; captured as a supporting file.",
        });
      }
      capture(state, probe, "supporting");
      // An explicitly-added schema file brings its transitive includes along.
      if (isXsdPath(path)) walkXmlImportsFromProbe(state, probe);
    }
  }
}

/** Directory import: probe every candidate, keep entrypoints and their graphs. */
async function importDirectory(state: ImportState, root: string): Promise<void> {
  state.root = root;
  const probes = new Map<string, Probe>();
  const patterns = SPEC_EXTENSIONS.map((ext) => `**/*.${ext}`);
  for await (const found of glob(patterns, { cwd: root })) {
    const rel = toPosix(found);
    if (rel.split("/").some(skippedSegment)) continue;
    // Resolve symlinks to their canonical in-root path; never follow outside.
    let real: string;
    try {
      real = realpathSync(join(root, rel));
    } catch {
      continue; // dangling symlink — nothing to capture
    }
    if (!statSync(real).isFile()) continue;
    if (!isInside(root, real)) {
      state.diagnostics.push({
        level: "warning",
        code: "source/path_escape",
        path: rel,
        message: "Symlink target lies outside the import root; not followed.",
      });
      continue;
    }
    const canonical = toPosix(relative(root, real));
    if (!probes.has(canonical)) probes.set(canonical, probeFile(root, canonical));
  }

  if (probes.size === 0) {
    state.diagnostics.push({
      level: "error",
      code: "source/empty",
      message: `No spec files found under '${root}'. Expected .yaml, .yml, or .json files.`,
    });
    return;
  }

  const detected = [...probes.values()]
    .map((probe) => ({ probe, format: probe.protocol ?? detectDeclaredFormat(probe.doc) }))
    .filter((c) => c.format !== undefined)
    .sort((a, b) => (a.probe.path < b.probe.path ? -1 : 1));

  if (detected.length === 0) {
    // Nothing declares a spec format: capture everything readable verbatim and
    // let the snapshot say `unclassified` — provenance without a format claim.
    for (const probe of sortByPath([...probes.values()])) capture(state, probe, "supporting");
    state.diagnostics.push({
      level: "warning",
      code: "source/unclassified",
      message:
        'No OpenAPI/Swagger document detected: no file declares `openapi:` (3.x) or `swagger: "2.0"`.',
    });
    return;
  }

  // Capture every entrypoint before walking any reference graph, so an
  // entrypoint reachable from another (a WSDL tree's abstract WSDL, a shared
  // OpenAPI document) keeps its `entrypoint` role instead of being demoted to
  // `reference` by whichever graph reaches it first.
  for (const { probe, format } of detected) {
    if (format === undefined) continue;
    state.entrypoints.push({ path: probe.path, format: format.format, version: format.version });
    capture(state, probe, "entrypoint");
  }
  for (const { probe, format } of detected) {
    if (format === undefined) continue;
    walkRefs(state, probe.path, probe.doc, probes);
    if (probe.protocol?.format === "wsdl") walkXmlImportsFromProbe(state, probe, probes);
  }
  // Everything probed but neither an entrypoint nor $ref-reachable is not part
  // of this source graph — excluded, and the exclusion is visible.
  for (const probe of sortByPath([...probes.values()])) {
    if (state.has(probe.path)) continue;
    state.diagnostics.push({
      level: "info",
      code: "source/unrelated_file",
      path: probe.path,
      message: "Not an entrypoint and not reachable from one; excluded from the snapshot.",
    });
  }
}

/* --------------------------------- $ref walk ------------------------------- */

/**
 * Resolve one reference target relative to `fromPath` and capture it as a
 * `reference` file, returning its probe — or undefined when the target was
 * external, missing, escaping, or already captured (each with its diagnostic).
 * The escape level differs by caller: an OpenAPI $ref that escapes the import
 * root is an error (the compile would fail at parse time without the bytes),
 * while a WSDL/XSD location degrades to a permissive schema at compile time,
 * so it stays a warning and the snapshot stays compilable.
 */
function captureReferenceTarget(
  state: ImportState,
  fromPath: string,
  ref: string,
  escapeLevel: "error" | "warning",
  probes?: Map<string, Probe>,
): Probe | undefined {
  const hash = ref.indexOf("#");
  const target = hash >= 0 ? ref.slice(0, hash) : ref;
  if (target === "") return undefined; // internal JSON pointer
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
    state.diagnostics.push({
      level: "info",
      code: "source/external_ref",
      path: fromPath,
      message: `External reference '${ref}' recorded as unresolved; remote content is never fetched.`,
    });
    return undefined;
  }
  const candidate = resolve(dirname(join(state.root, fromPath)), decodeRefPath(target));
  if (!existsSync(candidate)) {
    state.diagnostics.push({
      level: "warning",
      code: "source/ref_missing",
      path: fromPath,
      message: `Reference '${ref}' points at a file that does not exist.`,
    });
    return undefined;
  }
  const real = realpathSync(candidate);
  if (!isInside(state.root, real)) {
    state.diagnostics.push({
      level: escapeLevel,
      code: "source/path_escape",
      path: fromPath,
      message: `Reference '${ref}' escapes the import root; refusing to follow it.`,
    });
    return undefined;
  }
  const path = toPosix(relative(state.root, real));
  if (state.has(path)) return undefined; // shared targets are captured once
  const probe = probes?.get(path) ?? probeFile(state.root, path);
  capture(state, probe, "reference");
  return probe;
}

/**
 * Follow every LOCAL $ref reachable from `doc`, capturing each target once.
 * Remote refs are recorded as external and never fetched; refs escaping the
 * import root are rejected.
 */
function walkRefs(
  state: ImportState,
  fromPath: string,
  doc: unknown,
  probes?: Map<string, Probe>,
): void {
  const refs = new Set<string>();
  collectRefs(doc, refs, new WeakSet());
  for (const ref of [...refs].sort()) {
    const probe = captureReferenceTarget(state, fromPath, ref, "error", probes);
    if (probe?.doc !== undefined) walkRefs(state, probe.path, probe.doc, probes);
  }
}

/**
 * Follow every `wsdl:import` / `xsd:include` / `xsd:import` location reachable
 * from a WSDL or XSD file, capturing each target once — the XML analogue of
 * `walkRefs`, so a multi-file WSDL tree (entry WSDL → abstract WSDL → schema
 * files → transitive includes like `../common_v45_0/CommonReqRsp.xsd`) is
 * hermetic in the snapshot. The captured-once check terminates cycles.
 */
function walkXmlImports(
  state: ImportState,
  fromPath: string,
  text: string,
  probes?: Map<string, Probe>,
): void {
  for (const location of xmlImportLocations(text)) {
    const probe = captureReferenceTarget(state, fromPath, location, "warning", probes);
    if (!probe) continue;
    const decoded = decodeUtf8(probe.bytes);
    if (!("error" in decoded)) walkXmlImports(state, probe.path, decoded.text, probes);
  }
}

/** Decode a probe's bytes and follow its WSDL/XSD import locations. */
function walkXmlImportsFromProbe(
  state: ImportState,
  probe: Probe,
  probes?: Map<string, Probe>,
): void {
  const decoded = decodeUtf8(probe.bytes);
  if (!("error" in decoded)) walkXmlImports(state, probe.path, decoded.text, probes);
}

/** The import/include locations of an XML document; [] when it isn't XML. */
function xmlImportLocations(text: string): string[] {
  let root: XmlElement;
  try {
    root = parseXml(text);
  } catch {
    return [];
  }
  const locations = new Set<string>();
  for (const el of [...findAll(root, "import"), ...findAll(root, "include")]) {
    const location = el.attrs.location ?? el.attrs.schemaLocation;
    if (location) locations.add(location);
  }
  return [...locations].sort();
}

/** Gather every `$ref: <string>` in a parsed document, cycle-safe. */
function collectRefs(node: unknown, out: Set<string>, seen: WeakSet<object>): void {
  if (typeof node !== "object" || node === null) return;
  if (seen.has(node)) return; // YAML anchors can alias (even cyclically)
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out, seen);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") out.add(value);
    else collectRefs(value, out, seen);
  }
}

/* --------------------------------- helpers -------------------------------- */

/** $ref paths may be URI-escaped; a malformed escape falls back to verbatim. */
function decodeRefPath(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

/** The deepest directory containing every given (absolute, real) directory. */
function commonDirectory(dirs: string[]): string {
  let parts = (dirs[0] as string).split(sep);
  for (const dir of dirs.slice(1)) {
    const other = dir.split(sep);
    let i = 0;
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join(sep) || sep;
}
