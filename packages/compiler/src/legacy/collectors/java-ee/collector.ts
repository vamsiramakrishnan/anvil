import { Buffer } from "node:buffer";
import { type CollectionState, type ParsedMember, sha256 } from "./internal.js";
import type {
  JavaEeArtifactMember,
  JavaEeArtifactMembers,
  JavaEeCollectorOptions,
  JavaEeCollectorResult,
  JavaEeDiagnostic,
  JavaEeEvidence,
  JavaEeEvidenceRole,
  JavaEePlatform,
} from "./model.js";
import {
  parseApplicationDescriptor,
  parseEjbDescriptor,
  parseResourceAdapterDescriptor,
  parseWebDescriptor,
} from "./standard.js";
import {
  detectVendor,
  parseJbossBindings,
  parseWebLogicBindings,
  parseWebSphereBindings,
} from "./vendor.js";
import { childText, parseSafeDescriptorXml } from "./xml.js";

const DEFAULT_MAX_MEMBERS = 10_000;
const DEFAULT_MAX_MEMBER_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_PATH_BYTES = 4096;

interface AcceptedMember extends JavaEeArtifactMember {
  evidence: JavaEeEvidence;
}

/**
 * Discover Java EE deployment facts from an already hardened-expanded bundle.
 *
 * This pure function performs no filesystem, archive, network, classloading, or
 * bytecode operation. All input bytes and limits are explicit, making the result
 * deterministic and safe to run in an unprivileged compiler process.
 */
export function collectJavaEeLegacy(
  members: JavaEeArtifactMembers,
  options: JavaEeCollectorOptions = {},
): JavaEeCollectorResult {
  const diagnostics: JavaEeDiagnostic[] = [];
  const rawMembers = normalizeMembers(members);
  const configuredPlatforms = options.platform ? [options.platform] : [];
  if (rawMembers.length > (options.maxMembers ?? DEFAULT_MAX_MEMBERS)) {
    diagnostics.push({
      level: "error",
      code: "java-ee/member_limit_exceeded",
      message:
        `Expanded bundle contains ${rawMembers.length} members; limit is ` +
        `${options.maxMembers ?? DEFAULT_MAX_MEMBERS}. No partial inventory was produced.`,
    });
    return emptyResult(diagnostics, configuredPlatforms);
  }

  const accepted = acceptMembers(rawMembers, options, diagnostics);
  if (diagnostics.some((diagnostic) => diagnostic.code === "java-ee/bundle_too_large")) {
    return emptyResult(diagnostics, configuredPlatforms);
  }

  const parsed = parseMembers(accepted, options, diagnostics);
  const descriptorApplication = parsed
    .filter((member) => member.evidence.role === "application_descriptor")
    .map((member) => childText(member.root, "application-name"))
    .find(Boolean);
  const state: CollectionState = {
    application: options.application ?? descriptorApplication,
    observations: [],
    diagnostics,
    declarationCoordinates: new Map(),
  };

  for (const member of parsed) parseMember(state, member);

  const platforms = [
    ...new Set([...configuredPlatforms, ...parsed.map((member) => member.platform)]),
  ].sort();
  state.observations.sort((left, right) => left.id.localeCompare(right.id));
  state.diagnostics.sort(compareDiagnostics);
  return {
    collector: collectorDescriptor(platforms),
    evidence: accepted.map((member) => member.evidence),
    observations: state.observations,
    diagnostics: state.diagnostics,
  };
}

function normalizeMembers(members: JavaEeArtifactMembers): JavaEeArtifactMember[] {
  const normalized = Array.isArray(members)
    ? [...members]
    : Object.entries(members).map(([path, content]) => ({ path, content }));
  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

function acceptMembers(
  members: readonly JavaEeArtifactMember[],
  options: JavaEeCollectorOptions,
  diagnostics: JavaEeDiagnostic[],
): AcceptedMember[] {
  const pathCounts = new Map<string, number>();
  for (const member of members) pathCounts.set(member.path, (pathCounts.get(member.path) ?? 0) + 1);

  const accepted: AcceptedMember[] = [];
  let totalBytes = 0;
  for (const member of members) {
    if ((pathCounts.get(member.path) ?? 0) > 1) {
      if (
        !diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "java-ee/duplicate_member_path" &&
            diagnostic.coordinate?.path === member.path,
        )
      ) {
        diagnostics.push({
          level: "error",
          code: "java-ee/duplicate_member_path",
          message: `Expanded bundle contains duplicate member path ${JSON.stringify(member.path)}; every copy was ignored.`,
          coordinate: { path: member.path },
        });
      }
      continue;
    }
    if (!safeRelativePath(member.path)) {
      diagnostics.push({
        level: "error",
        code: "java-ee/unsafe_member_path",
        message: `Member path ${JSON.stringify(member.path)} is not a safe relative POSIX path.`,
        coordinate: { path: member.path },
      });
      continue;
    }
    if (typeof member.content !== "string" || !wellFormedUnicode(member.content)) {
      diagnostics.push({
        level: "error",
        code: "java-ee/member_not_utf8",
        message: `Member ${JSON.stringify(member.path)} is not losslessly representable as UTF-8 text.`,
        coordinate: { path: member.path },
      });
      continue;
    }
    const bytes = Buffer.byteLength(member.content, "utf8");
    if (bytes > (options.maxMemberBytes ?? DEFAULT_MAX_MEMBER_BYTES)) {
      diagnostics.push({
        level: "error",
        code: "java-ee/member_too_large",
        message:
          `Member ${JSON.stringify(member.path)} is ${bytes} bytes; limit is ` +
          `${options.maxMemberBytes ?? DEFAULT_MAX_MEMBER_BYTES}.`,
        coordinate: { path: member.path },
      });
      continue;
    }
    totalBytes += bytes;
    accepted.push({
      ...member,
      evidence: {
        path: member.path,
        digest: sha256(member.content),
        bytes,
        role: roleForPath(member.path),
      },
    });
  }

  if (totalBytes > (options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES)) {
    diagnostics.push({
      level: "error",
      code: "java-ee/bundle_too_large",
      message:
        `Accepted expanded members total ${totalBytes} bytes; limit is ` +
        `${options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES}. No partial inventory was produced.`,
    });
    return [];
  }
  return accepted;
}

function parseMembers(
  members: readonly AcceptedMember[],
  options: JavaEeCollectorOptions,
  diagnostics: JavaEeDiagnostic[],
): ParsedMember[] {
  const parsed: ParsedMember[] = [];
  for (const member of members) {
    if (member.evidence.role === "uninterpreted") continue;
    const document = parseSafeDescriptorXml(member.content);
    if (!document.ok) {
      diagnostics.push({
        level: "error",
        code: document.kind === "unsafe" ? "java-ee/unsafe_xml_construct" : "java-ee/malformed_xml",
        message: `Could not inspect ${member.path}: ${document.message}`,
        coordinate: { path: member.path },
      });
      continue;
    }
    const vendor = detectVendor(member.path, document.root);
    const platform = vendor ?? options.platform ?? "java-ee";
    parsed.push({ evidence: member.evidence, root: document.root, platform });
  }
  return parsed;
}

function parseMember(state: CollectionState, member: ParsedMember): void {
  switch (member.evidence.role) {
    case "application_descriptor":
      parseApplicationDescriptor(state, member);
      break;
    case "web_descriptor":
      parseWebDescriptor(state, member);
      break;
    case "ejb_descriptor":
      parseEjbDescriptor(state, member);
      break;
    case "resource_adapter_descriptor":
      parseResourceAdapterDescriptor(state, member);
      break;
    case "vendor_binding":
    case "vendor_configuration":
      parseVendorMember(state, member);
      break;
    case "uninterpreted":
      break;
  }
}

function parseVendorMember(state: CollectionState, member: ParsedMember): void {
  switch (member.platform) {
    case "weblogic":
      parseWebLogicBindings(state, member);
      break;
    case "websphere":
      parseWebSphereBindings(state, member);
      break;
    case "jboss":
      parseJbossBindings(state, member);
      break;
    case "java-ee":
      state.diagnostics.push({
        level: "warning",
        code: "java-ee/opaque_vendor_binding",
        message: "Configuration XML was captured but its vendor vocabulary was not recognized.",
        coordinate: { path: member.evidence.path },
      });
      break;
  }
}

function roleForPath(path: string): JavaEeEvidenceRole {
  const lower = path.toLowerCase();
  if (lower.endsWith("meta-inf/application.xml")) return "application_descriptor";
  if (lower.endsWith("web-inf/web.xml")) return "web_descriptor";
  if (lower.endsWith("meta-inf/ejb-jar.xml")) return "ejb_descriptor";
  if (lower.endsWith("meta-inf/ra.xml")) return "resource_adapter_descriptor";
  const base = lower.split("/").at(-1) ?? lower;
  if (
    /^(?:weblogic|jboss)(?:-.+)?\.xml$/u.test(base) ||
    /^ibm-.+\.xml$/u.test(base) ||
    base.endsWith("-bnd.xmi")
  ) {
    return "vendor_binding";
  }
  if (
    ["standalone.xml", "domain.xml", "server.xml", "resources.xml", "config.xml"].includes(base)
  ) {
    return "vendor_configuration";
  }
  return "uninterpreted";
}

function safeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  if (Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) return false;
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function collectorDescriptor(platforms: JavaEePlatform[]): JavaEeCollectorResult["collector"] {
  return {
    kind: "java-ee",
    schemaVersion: 1,
    mode: "offline_expanded_members",
    deterministic: true,
    archiveAccess: false,
    bytecodeExecution: false,
    platforms,
  };
}

function emptyResult(
  diagnostics: JavaEeDiagnostic[],
  platforms: JavaEePlatform[],
): JavaEeCollectorResult {
  return {
    collector: collectorDescriptor([...new Set(platforms)].sort()),
    evidence: [],
    observations: [],
    diagnostics: diagnostics.sort(compareDiagnostics),
  };
}

function compareDiagnostics(left: JavaEeDiagnostic, right: JavaEeDiagnostic): number {
  return (
    (left.coordinate?.path ?? "").localeCompare(right.coordinate?.path ?? "") ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );
}
