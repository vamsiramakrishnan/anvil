import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  ArchiveDecodeError,
  DEFAULT_ARCHIVE_LIMITS,
  GATEWAY_MAX_ARTIFACT_EVIDENCE,
  type GatewayArtifactEvidence,
  GatewayArtifactEvidence as GatewayArtifactEvidenceSchema,
  type GatewayDiagnostic,
  gatewaySha256,
  readArchive,
  type Wso2ApiProject,
  ZipArchiveDecoder,
} from "@anvil/compiler";
import { parseDocument } from "yaml";

interface CollectionFile {
  /** Safe POSIX path relative to the collection root. */
  path: string;
  bytes: Uint8Array;
}

export interface LoadedWso2ApictlCollection {
  /** Deterministic, content-only snapshot stored by the immutable import receipt. */
  exportBytes: Uint8Array;
  /** Canonical expanded-member identity used by inventory, independent of ZIP repacking. */
  semanticDigest: string;
  projects: Wso2ApiProject[];
  diagnostics: GatewayDiagnostic[];
}

export class Wso2ApictlCollectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "Wso2ApictlCollectionError";
    this.code = code;
  }
}

const SNAPSHOT_MAGIC = new TextEncoder().encode("ANVIL_WSO2_APICTL_COLLECTION_V1\0");
/** Estate-scale bound; each individual ZIP still uses the stricter archive harness limits. */
export const WSO2_COLLECTION_MAX_FILES = GATEWAY_MAX_ARTIFACT_EVIDENCE - 1;
export const WSO2_COLLECTION_MAX_EXPANDED_BYTES = DEFAULT_ARCHIVE_LIMITS.maxExpandedBytes;

function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

/** Walk an extracted collection without following symlinks or special nodes. */
function readDirectoryFiles(root: string): CollectionFile[] {
  const files: CollectionFile[] = [];
  let totalBytes = 0;

  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!safePath(relative)) {
        throw new Wso2ApictlCollectionError(
          "wso2/unsafe_collection_path",
          `WSO2 collection contains an unsafe path '${relative}'.`,
        );
      }
      if (pathDepth(relative) > DEFAULT_ARCHIVE_LIMITS.maxDepth) {
        throw new Wso2ApictlCollectionError(
          "wso2/collection_too_deep",
          `WSO2 collection path '${relative}' exceeds depth ${DEFAULT_ARCHIVE_LIMITS.maxDepth}.`,
        );
      }
      const absolute = join(directory, entry.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new Wso2ApictlCollectionError(
          "wso2/collection_symlink_rejected",
          `WSO2 collection symlink '${relative}' was rejected.`,
        );
      }
      if (stat.isDirectory()) {
        visit(absolute, relative);
        continue;
      }
      if (!stat.isFile()) {
        throw new Wso2ApictlCollectionError(
          "wso2/unsupported_collection_node",
          `WSO2 collection contains unsupported filesystem node '${relative}'.`,
        );
      }
      if (files.length >= WSO2_COLLECTION_MAX_FILES) {
        throw new Wso2ApictlCollectionError(
          "wso2/collection_too_many_files",
          `WSO2 collection exceeds ${WSO2_COLLECTION_MAX_FILES} files.`,
        );
      }
      if (stat.size > DEFAULT_ARCHIVE_LIMITS.maxFileBytes) {
        throw new Wso2ApictlCollectionError(
          "wso2/collection_file_too_large",
          `WSO2 collection file '${relative}' exceeds ${DEFAULT_ARCHIVE_LIMITS.maxFileBytes} bytes.`,
        );
      }
      totalBytes += stat.size;
      if (totalBytes > WSO2_COLLECTION_MAX_EXPANDED_BYTES) {
        throw new Wso2ApictlCollectionError(
          "wso2/collection_too_large",
          `WSO2 collection exceeds ${WSO2_COLLECTION_MAX_EXPANDED_BYTES} bytes.`,
        );
      }
      files.push({ path: relative, bytes: readFileSync(absolute) });
    }
  };

  visit(root, "");
  return files;
}

/**
 * A deterministic byte envelope for an extracted directory. It preserves every
 * accepted path and byte without depending on host paths, mtimes, ownership, or
 * traversal order.
 */
function encodeCollectionSnapshot(files: readonly CollectionFile[]): Uint8Array {
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
  const encoder = new TextEncoder();
  const records = sorted.map((file) => ({
    file,
    pathBytes: encoder.encode(file.path),
  }));
  const total =
    SNAPSHOT_MAGIC.byteLength +
    4 +
    records.reduce(
      (bytes, record) => bytes + 4 + 8 + record.pathBytes.byteLength + record.file.bytes.byteLength,
      0,
    );
  const output = Buffer.allocUnsafe(total);
  let offset = 0;
  output.set(SNAPSHOT_MAGIC, offset);
  offset += SNAPSHOT_MAGIC.byteLength;
  output.writeUInt32BE(records.length, offset);
  offset += 4;
  for (const record of records) {
    output.writeUInt32BE(record.pathBytes.byteLength, offset);
    offset += 4;
    output.writeBigUInt64BE(BigInt(record.file.bytes.byteLength), offset);
    offset += 8;
    output.set(record.pathBytes, offset);
    offset += record.pathBytes.byteLength;
    output.set(record.file.bytes, offset);
    offset += record.file.bytes.byteLength;
  }
  return output;
}

function basenameLower(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).toLowerCase();
}

function isSupportedFormalDefinitionPath(path: string): boolean {
  const lower = path.toLowerCase();
  const base = basenameLower(lower);
  return (
    lower.split("/").includes("definitions") &&
    /^(?:swagger|openapi)\.(?:yaml|yml|json)$/.test(base)
  );
}

function invalidFormalDefinitionReason(file: CollectionFile): string | undefined {
  if (!isSupportedFormalDefinitionPath(file.path)) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    return "member is not valid UTF-8";
  }
  try {
    const document = parseDocument(text, { strict: true, uniqueKeys: true });
    if (document.errors.length > 0) {
      return `member cannot be parsed: ${document.errors[0]?.message ?? "invalid YAML/JSON"}`;
    }
    const value = document.toJS({ maxAliasCount: 50 });
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return "member must contain a mapping/object";
    }
    const record = value as Record<string, unknown>;
    const openapi = typeof record.openapi === "string" ? record.openapi.trim() : undefined;
    const swagger =
      typeof record.swagger === "string" || typeof record.swagger === "number"
        ? String(record.swagger).trim()
        : undefined;
    if ((openapi && /^3(?:\.[0-9]+){1,2}$/.test(openapi)) || swagger === "2.0" || swagger === "2") {
      return undefined;
    }
    return "member does not declare a supported top-level OpenAPI 3.x or Swagger 2.0 version";
  } catch (error) {
    return `member cannot be parsed safely: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function artifactRole(
  path: string,
  invalidFormalDefinitions: ReadonlySet<string> = new Set(),
): GatewayArtifactEvidence["role"] {
  const lower = path.toLowerCase();
  const base = basenameLower(lower);
  if (base === "api.yaml") return "api_definition";
  if (base === "api_meta.yaml") return "api_metadata";
  if (base === "deployment_environments.yaml") return "deployment_environments";
  if (isSupportedFormalDefinitionPath(path) && !invalidFormalDefinitions.has(path)) {
    return "formal_definition";
  }
  if (
    lower.endsWith(".car") ||
    lower
      .split("/")
      .some((segment) =>
        ["policies", "sequences", "mediation", "mediationpolicies"].includes(segment),
      )
  ) {
    return "opaque_policy";
  }
  return "uninterpreted";
}

function artifact(input: GatewayArtifactEvidence): GatewayArtifactEvidence {
  return GatewayArtifactEvidenceSchema.parse(input);
}

function relativeToProject(path: string, projectRoot: string): string {
  return projectRoot === "." ? path : path.slice(projectRoot.length + 1);
}

function projectFromMembers(input: {
  containerPath: string;
  containerOrigin: string;
  containerDigest: string;
  containerBytes: number;
  packaging?: { digest: string; bytes: number };
  files: readonly CollectionFile[];
  memberOrigin: (file: CollectionFile) => string;
}): { project?: Wso2ApiProject; diagnostics: GatewayDiagnostic[] } {
  const apiFiles = input.files.filter((file) => basenameLower(file.path) === "api.yaml");
  if (apiFiles.length !== 1) return { diagnostics: [] };
  const apiFile = apiFiles[0] as CollectionFile;
  const apiText = new TextDecoder("utf-8", { fatal: true }).decode(apiFile.bytes);
  const deploymentFile = input.files.find(
    (file) => basenameLower(file.path) === "deployment_environments.yaml",
  );
  const deploymentText = deploymentFile
    ? new TextDecoder("utf-8", { fatal: true }).decode(deploymentFile.bytes)
    : undefined;
  const containerEvidence = artifact({
    kind: "container",
    role: "api_project",
    path: input.containerPath,
    origin: input.containerOrigin,
    digest: input.containerDigest,
    bytes: input.containerBytes,
    ...(input.packaging ? { packaging: input.packaging } : {}),
  });
  const invalidFormalDefinitions = new Map<string, string>();
  for (const file of input.files) {
    const reason = invalidFormalDefinitionReason(file);
    if (reason) invalidFormalDefinitions.set(file.path, reason);
  }
  const invalidFormalPaths = new Set(invalidFormalDefinitions.keys());
  const memberEvidence = input.files
    .map((file) =>
      artifact({
        kind: "member",
        role: artifactRole(file.path, invalidFormalPaths),
        path: file.path,
        origin: input.memberOrigin(file),
        digest: gatewaySha256(file.bytes),
        bytes: file.bytes.byteLength,
        parent: {
          origin: input.containerOrigin,
          digest: input.containerDigest,
        },
      }),
    )
    .sort((left, right) => left.origin.localeCompare(right.origin));
  const diagnostics: GatewayDiagnostic[] = [...invalidFormalDefinitions.entries()].map(
    ([path, reason]) => ({
      level: "error",
      code: "wso2/invalid_formal_definition",
      message:
        `Definitions member '${path}' is not a validated OpenAPI/Swagger contract: ${reason}. ` +
        "It remains preserved as uninterpreted evidence and is not eligible for automatic digest matching.",
      coordinate: { origin: input.memberOrigin({ path, bytes: new Uint8Array() }) },
      subject: {
        artifact: {
          origin: input.containerOrigin,
          digest: input.containerDigest,
        },
      },
    }),
  );
  return {
    project: {
      apiYaml: apiText,
      apiOrigin: input.memberOrigin(apiFile),
      ...(deploymentText !== undefined
        ? {
            deploymentEnvironmentsYaml: deploymentText,
            deploymentEnvironmentsOrigin: input.memberOrigin(deploymentFile as CollectionFile),
          }
        : {}),
      artifacts: [containerEvidence, ...memberEvidence],
    },
    diagnostics,
  };
}

function rebaseOrigin(origin: string, from: string, to: string): string {
  return origin === from || origin.startsWith(`${from}!`)
    ? `${to}${origin.slice(from.length)}`
    : origin;
}

function rebaseProject(project: Wso2ApiProject, from: string, to: string): Wso2ApiProject {
  return {
    ...project,
    apiOrigin: rebaseOrigin(project.apiOrigin, from, to),
    deploymentEnvironmentsOrigin: project.deploymentEnvironmentsOrigin
      ? rebaseOrigin(project.deploymentEnvironmentsOrigin, from, to)
      : undefined,
    artifacts: project.artifacts.map((artifact) => ({
      ...artifact,
      origin: rebaseOrigin(artifact.origin, from, to),
      parent: artifact.parent
        ? {
            ...artifact.parent,
            origin: rebaseOrigin(artifact.parent.origin, from, to),
          }
        : undefined,
    })),
  };
}

function rebaseDiagnostic(
  diagnostic: GatewayDiagnostic,
  from: string,
  to: string,
): GatewayDiagnostic {
  return {
    ...diagnostic,
    coordinate: diagnostic.coordinate
      ? {
          ...diagnostic.coordinate,
          origin: rebaseOrigin(diagnostic.coordinate.origin, from, to),
        }
      : undefined,
    subject: diagnostic.subject
      ? {
          ...diagnostic.subject,
          artifact: diagnostic.subject.artifact
            ? {
                ...diagnostic.subject.artifact,
                origin: rebaseOrigin(diagnostic.subject.artifact.origin, from, to),
              }
            : undefined,
        }
      : undefined,
  };
}

function collectionSemanticDigest(
  files: readonly CollectionFile[],
  projects: readonly Wso2ApiProject[],
  diagnostics: readonly GatewayDiagnostic[],
): string {
  const records = {
    looseFiles: files
      .filter((file) => !file.path.toLowerCase().endsWith(".zip"))
      .map((file) => ({ path: file.path, digest: gatewaySha256(file.bytes) }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    projects: projects
      .map((project) =>
        project.artifacts
          .map((artifact) => ({
            kind: artifact.kind,
            role: artifact.role,
            path: artifact.path,
            digest: artifact.digest,
            bytes: artifact.bytes,
            parentDigest: artifact.parent?.digest,
          }))
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      )
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    diagnostics: diagnostics
      .map((diagnostic) => ({
        level: diagnostic.level,
        code: diagnostic.code,
        artifactDigest: diagnostic.subject?.artifact?.digest,
        pointer: diagnostic.coordinate?.pointer,
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
  return gatewaySha256(new TextEncoder().encode(JSON.stringify(records)));
}

function directZipProject(
  bytes: Uint8Array,
  containerPath: string,
  containerOrigin: string,
): {
  project?: Wso2ApiProject;
  files: CollectionFile[];
  diagnostics: GatewayDiagnostic[];
} {
  const packagingDigest = gatewaySha256(bytes);
  let artifactSubject = {
    artifact: { origin: containerOrigin, digest: packagingDigest },
  } as const;
  let decoded: ReturnType<typeof readArchive>;
  try {
    decoded = readArchive(bytes, new ZipArchiveDecoder());
  } catch (error) {
    return {
      files: [],
      diagnostics: [
        {
          level: "error",
          code: "wso2/apictl_archive_refused",
          message:
            error instanceof ArchiveDecodeError
              ? `WSO2 apictl archive '${containerPath}' refused: ${error.message}`
              : `Cannot decode WSO2 apictl archive '${containerPath}': ${String(error)}`,
          coordinate: { origin: containerOrigin },
          subject: artifactSubject,
        },
      ],
    };
  }
  if (!decoded.ok) {
    return {
      files: [],
      diagnostics: [
        {
          level: "error",
          code: "wso2/apictl_archive_refused",
          message: `WSO2 apictl archive '${containerPath}' failed the archive safety battery: ${decoded.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`,
          coordinate: { origin: containerOrigin },
          subject: artifactSubject,
        },
      ],
    };
  }
  const files = decoded.files.map((file) => ({ path: file.path, bytes: file.bytes }));
  const containerDigest = gatewaySha256(encodeCollectionSnapshot(files));
  artifactSubject = {
    artifact: { origin: containerOrigin, digest: containerDigest },
  };
  const apiFiles = files.filter((file) => basenameLower(file.path) === "api.yaml");
  if (apiFiles.length === 0) {
    return {
      files,
      diagnostics: [
        {
          level: "warning",
          code: "wso2/unsupported_collection_archive",
          message:
            `ZIP '${containerPath}' contains no api.yaml and was not treated as an API project ` +
            `(${containerDigest}). CAR and arbitrary ZIP internals remain opaque.`,
          coordinate: { origin: containerOrigin },
          subject: artifactSubject,
        },
      ],
    };
  }
  if (apiFiles.length > 1) {
    return {
      files,
      diagnostics: [
        {
          level: "error",
          code: "wso2/ambiguous_apictl_archive",
          message: `ZIP '${containerPath}' contains ${apiFiles.length} api.yaml members; one apictl archive must identify exactly one API project.`,
          coordinate: { origin: containerOrigin },
          subject: artifactSubject,
        },
      ],
    };
  }
  let built: ReturnType<typeof projectFromMembers>;
  try {
    built = projectFromMembers({
      containerPath,
      containerOrigin,
      containerDigest,
      containerBytes: files.reduce((total, file) => total + file.bytes.byteLength, 0),
      packaging: { digest: packagingDigest, bytes: bytes.byteLength },
      files,
      memberOrigin: (file) => `${containerOrigin}!${file.path}`,
    });
  } catch (error) {
    return {
      files,
      diagnostics: [
        {
          level: "error",
          code: "wso2/invalid_apictl_member_encoding",
          message: `Cannot decode required YAML in '${containerPath}': ${String(error)}`,
          coordinate: { origin: containerOrigin },
          subject: artifactSubject,
        },
      ],
    };
  }
  return {
    files,
    project: built.project,
    diagnostics: built.diagnostics,
  };
}

/** Load one native per-API apictl ZIP without requiring `--entry api.yaml`. */
export function loadWso2ApictlZip(
  bytes: Uint8Array,
  displayName = "api-project.zip",
): LoadedWso2ApictlCollection {
  const packagingDigest = gatewaySha256(bytes);
  const packagingOrigin = `gateway-export://${packagingDigest}`;
  const safeDisplayName = safePath(basename(displayName))
    ? basename(displayName)
    : "api-project.zip";
  const decoded = directZipProject(bytes, safeDisplayName, packagingOrigin);
  const semanticDigest =
    decoded.files.length > 0
      ? gatewaySha256(encodeCollectionSnapshot(decoded.files))
      : packagingDigest;
  const semanticOrigin = `gateway-export://${semanticDigest}`;
  const diagnostics = decoded.diagnostics.map((diagnostic) =>
    rebaseDiagnostic(diagnostic, packagingOrigin, semanticOrigin),
  );
  const project = decoded.project
    ? rebaseProject(decoded.project, packagingOrigin, semanticOrigin)
    : undefined;
  if (!decoded.project) {
    return {
      exportBytes: bytes,
      semanticDigest,
      projects: [],
      diagnostics: [
        ...diagnostics,
        ...(diagnostics.some((diagnostic) => diagnostic.level === "error")
          ? []
          : [
              {
                level: "error" as const,
                code: "wso2/no_apictl_api_projects",
                message: "The ZIP contains no independently selectable native apictl API project.",
                coordinate: { origin: semanticOrigin },
              },
            ]),
      ],
    };
  }
  return {
    exportBytes: bytes,
    semanticDigest,
    projects: project ? [project] : [],
    diagnostics,
  };
}

/**
 * Load an apictl bulk export directory containing per-API ZIPs, extracted
 * per-API directories, or both. It never constructs an invented `apis:` YAML
 * document: every project stays independently parsed and selectable.
 */
export function loadWso2ApictlDirectory(root: string): LoadedWso2ApictlCollection {
  const files = readDirectoryFiles(root);
  if (files.length === 0) {
    throw new Wso2ApictlCollectionError(
      "wso2/empty_apictl_collection",
      "WSO2 apictl collection directory contains no files.",
    );
  }
  const exportBytes = encodeCollectionSnapshot(files);
  const packagingOrigin = `gateway-export://${gatewaySha256(exportBytes)}`;
  const diagnostics: GatewayDiagnostic[] = [];
  const projects: Wso2ApiProject[] = [];
  let decodedFiles = files.length;
  let decodedBytes = files.reduce((total, file) => total + file.bytes.byteLength, 0);

  const apiFiles = files.filter((file) => basenameLower(file.path) === "api.yaml");
  const extractedRoots = apiFiles
    .map((file) => dirname(file.path).replaceAll("\\", "/"))
    .map((path) => (path === "" ? "." : path))
    .sort();
  for (let index = 0; index < extractedRoots.length; index += 1) {
    const rootPath = extractedRoots[index] as string;
    const nested = extractedRoots.some(
      (candidate, candidateIndex) =>
        candidateIndex !== index && (rootPath === "." || candidate.startsWith(`${rootPath}/`)),
    );
    if (nested) {
      const projectFiles = files
        .filter((file) => rootPath === "." || file.path.startsWith(`${rootPath}/`))
        .map((file) => ({
          path: relativeToProject(file.path, rootPath),
          bytes: file.bytes,
        }));
      const projectDigest = gatewaySha256(encodeCollectionSnapshot(projectFiles));
      const projectOrigin = `${packagingOrigin}!${rootPath === "." ? "api-project/" : `${rootPath}/`}`;
      diagnostics.push({
        level: "error",
        code: "wso2/ambiguous_extracted_project",
        message: `Extracted apictl project '${rootPath}' contains another api.yaml project; projects must be sibling roots.`,
        coordinate: { origin: projectOrigin },
        subject: { artifact: { origin: projectOrigin, digest: projectDigest } },
      });
      continue;
    }
    const projectFiles = files
      .filter((file) => rootPath === "." || file.path.startsWith(`${rootPath}/`))
      .map((file) => ({
        path: relativeToProject(file.path, rootPath),
        bytes: file.bytes,
      }));
    const projectSnapshot = encodeCollectionSnapshot(projectFiles);
    const containerOrigin = `${packagingOrigin}!${rootPath === "." ? "api-project/" : `${rootPath}/`}`;
    const containerDigest = gatewaySha256(projectSnapshot);
    try {
      const built = projectFromMembers({
        containerPath: rootPath === "." ? "api-project" : rootPath,
        containerOrigin,
        containerDigest,
        containerBytes: projectFiles.reduce((total, file) => total + file.bytes.byteLength, 0),
        files: projectFiles,
        memberOrigin: (file) =>
          `${packagingOrigin}!${rootPath === "." ? file.path : `${rootPath}/${file.path}`}`,
      });
      diagnostics.push(...built.diagnostics);
      if (built.project) projects.push(built.project);
    } catch (error) {
      diagnostics.push({
        level: "error",
        code: "wso2/invalid_apictl_member_encoding",
        message: `Cannot decode required YAML in extracted project '${rootPath}': ${String(error)}`,
        coordinate: { origin: containerOrigin },
        subject: { artifact: { origin: containerOrigin, digest: containerDigest } },
      });
    }
  }

  const insideExtractedProject = (path: string): boolean =>
    extractedRoots.some((rootPath) => rootPath === "." || path.startsWith(`${rootPath}/`));
  for (const file of files.filter(
    (candidate) =>
      candidate.path.toLowerCase().endsWith(".zip") && !insideExtractedProject(candidate.path),
  )) {
    const containerOrigin = `${packagingOrigin}!${file.path}`;
    const decoded = directZipProject(file.bytes, file.path, containerOrigin);
    diagnostics.push(...decoded.diagnostics);
    decodedFiles += decoded.files.length;
    decodedBytes += decoded.files.reduce((total, member) => total + member.bytes.byteLength, 0);
    if (
      decodedFiles > WSO2_COLLECTION_MAX_FILES ||
      decodedBytes > WSO2_COLLECTION_MAX_EXPANDED_BYTES
    ) {
      throw new Wso2ApictlCollectionError(
        "wso2/collection_expansion_limit",
        "WSO2 apictl ZIP collection exceeds the aggregate expanded file/byte limit.",
      );
    }
    if (decoded.project) projects.push(decoded.project);
  }

  for (const file of files.filter(
    (candidate) =>
      candidate.path.toLowerCase().endsWith(".car") && !insideExtractedProject(candidate.path),
  )) {
    const artifactOrigin = `${packagingOrigin}!${file.path}`;
    const artifactDigest = gatewaySha256(file.bytes);
    diagnostics.push({
      level: "warning",
      code: "wso2/opaque_car",
      message:
        `WSO2 CAR '${file.path}' is preserved in collection lineage but its internals are not interpreted ` +
        `(digest ${artifactDigest}).`,
      coordinate: { origin: artifactOrigin },
      subject: { artifact: { origin: artifactOrigin, digest: artifactDigest } },
    });
  }

  if (projects.length === 0 && !diagnostics.some((diagnostic) => diagnostic.level === "error")) {
    diagnostics.push({
      level: "error",
      code: "wso2/no_apictl_api_projects",
      message:
        "The directory contains no native apictl API project (expected one api.yaml per extracted project or per-API ZIP).",
      coordinate: { origin: packagingOrigin },
    });
  }

  const semanticDigest = collectionSemanticDigest(files, projects, diagnostics);
  const semanticOrigin = `gateway-export://${semanticDigest}`;
  return {
    exportBytes,
    semanticDigest,
    projects: projects
      .map((project) => rebaseProject(project, packagingOrigin, semanticOrigin))
      .sort((left, right) => left.apiOrigin.localeCompare(right.apiOrigin)),
    diagnostics: diagnostics
      .map((diagnostic) => rebaseDiagnostic(diagnostic, packagingOrigin, semanticOrigin))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
}
