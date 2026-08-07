import { createHash } from "node:crypto";
import { hashCanonical } from "@anvil/air";
import { z } from "zod";
import { collectDotnetLegacy } from "./collectors/dotnet/index.js";
import { collectJavaEeLegacy } from "./collectors/java-ee/index.js";
import { collectMessagingLegacy } from "./collectors/messaging/index.js";
import {
  createLegacyArtifact,
  EvidenceSourceKind,
  finalizeLegacyInventory,
  type LegacyArtifactRole,
  type LegacyCapabilityCandidate,
  LegacyEstate,
  LegacyIdentifier,
  type LegacyInventorySnapshot,
  LegacyRelativePath,
  reconcileLegacyInventory,
} from "./core/index.js";
import {
  addNoInvocationDiagnostic,
  type NormalizationState,
  normalizeDiagnostic,
  normalizeDotnetObservation,
  normalizeJavaObservation,
  normalizeMessagingObservation,
} from "./normalization.js";

export const LegacyCollectorKind = z.enum(["auto", "java-ee", "dotnet", "messaging"]);
export type LegacyCollectorKind = z.infer<typeof LegacyCollectorKind>;

export interface LegacySourceMember {
  path: string;
  bytes: Uint8Array;
  /** Overrides the invocation default when this member has a distinct authority. */
  source?: {
    kind: EvidenceSourceKind;
    systemId: string;
    revision?: string;
  };
}

export interface CollectLegacyInventoryInput {
  estate: { id: string; name?: string };
  environment: string;
  application: string;
  source: {
    kind: EvidenceSourceKind;
    systemId: string;
    revision?: string;
  };
  collector?: LegacyCollectorKind;
  members: readonly LegacySourceMember[];
}

export interface LegacyInventoryStreamLimits {
  maxMembers?: number;
  maxMemberBytes?: number;
  maxTotalBytes?: number;
}

export type CollectLegacyInventoryStreamInput = Omit<CollectLegacyInventoryInput, "members"> & {
  members: AsyncIterable<LegacySourceMember>;
  limits?: LegacyInventoryStreamLimits;
};

export interface LegacyCollectorRun {
  collector: Exclude<LegacyCollectorKind, "auto">;
  inputMembers: number;
  observations: number;
  diagnostics: number;
}

export interface LegacyInventoryResult {
  snapshot: LegacyInventorySnapshot;
  candidates: LegacyCapabilityCandidate[];
  collectors: LegacyCollectorRun[];
}

const DEFAULT_STREAM_LIMITS = {
  maxMembers: 20_000,
  maxMemberBytes: 16 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
} as const;

/**
 * Convert bounded, caller-supplied legacy exports into one deterministic
 * evidence inventory. Collectors describe only declared technical facts; this
 * seam deliberately does not invent business operations or approval state.
 */
export function collectLegacyInventory(input: CollectLegacyInventoryInput): LegacyInventoryResult {
  const estate = LegacyEstate.parse(input.estate);
  const environment = LegacyIdentifier.parse(input.environment);
  const application = LegacyIdentifier.parse(input.application);
  const systemId = LegacyIdentifier.parse(input.source.systemId);
  const collector = LegacyCollectorKind.parse(input.collector ?? "auto");
  const members = normalizeMembers(input.members);
  const deploymentDigest = sha256(
    hashCanonical(
      members.map((member) => ({ path: member.path, digest: sha256Bytes(member.bytes) })),
    ),
  );
  const artifacts = members.map((member) => {
    const memberSource = member.source
      ? {
          kind: EvidenceSourceKind.parse(member.source.kind),
          systemId: LegacyIdentifier.parse(member.source.systemId),
          ...(member.source.revision ? { revision: member.source.revision } : {}),
        }
      : {
          kind: input.source.kind,
          systemId,
          ...(input.source.revision ? { revision: input.source.revision } : {}),
        };
    return createLegacyArtifact({
      schemaVersion: 1,
      digest: sha256Bytes(member.bytes),
      bytes: member.bytes.byteLength,
      mediaType: mediaType(member.path),
      role: artifactRole(member.path),
      path: member.path,
      source: memberSource,
    });
  });
  const state: NormalizationState = {
    artifactsByPath: new Map(artifacts.map((artifact) => [artifact.path, artifact])),
    evidenceById: new Map(),
    observations: [],
    diagnostics: [],
    coordinate: { environment, application, deploymentDigest },
  };
  const collectors: LegacyCollectorRun[] = [];

  if (collector === "auto" || collector === "java-ee") {
    const selected = selectJavaMembers(members, collector === "java-ee", state);
    if (selected.length > 0) {
      const diagnosticsBefore = state.diagnostics.length;
      const result = collectJavaEeLegacy(selected, { application });
      const normalizedBefore = state.observations.length;
      const vendorPlatforms = result.collector.platforms.filter(
        (platform) => platform !== "java-ee",
      );
      const effectivePlatform = vendorPlatforms.length === 1 ? vendorPlatforms[0] : undefined;
      for (const observation of result.observations) {
        normalizeJavaObservation(state, observation, result.observations, effectivePlatform);
      }
      for (const diagnostic of result.diagnostics) {
        state.diagnostics.push(normalizeDiagnostic(state, "java-ee", diagnostic));
      }
      addNoInvocationDiagnostic(
        state,
        "java-ee",
        result.observations.length,
        state.observations.length - normalizedBefore,
        result.diagnostics,
      );
      collectors.push({
        collector: "java-ee",
        inputMembers: selected.length,
        observations: state.observations.length - normalizedBefore,
        diagnostics: state.diagnostics.length - diagnosticsBefore,
      });
    }
  }

  if (collector === "auto" || collector === "dotnet") {
    const selected = selectDotnetMembers(members, collector === "dotnet");
    if (selected.length > 0) {
      const diagnosticsBefore = state.diagnostics.length;
      const result = collectDotnetLegacy(selected);
      const normalizedBefore = state.observations.length;
      for (const observation of result.observations) normalizeDotnetObservation(state, observation);
      for (const diagnostic of result.diagnostics) {
        state.diagnostics.push(normalizeDiagnostic(state, "dotnet", diagnostic));
      }
      addNoInvocationDiagnostic(
        state,
        "dotnet",
        result.observations.length,
        state.observations.length - normalizedBefore,
        result.diagnostics,
      );
      collectors.push({
        collector: "dotnet",
        inputMembers: selected.length,
        observations: state.observations.length - normalizedBefore,
        diagnostics: state.diagnostics.length - diagnosticsBefore,
      });
    }
  }

  if (collector === "auto" || collector === "messaging") {
    const selected = selectMessagingMembers(members, collector === "messaging");
    if (selected.length > 0) {
      const diagnosticsBefore = state.diagnostics.length;
      const result = collectMessagingLegacy(selected);
      const normalizedBefore = state.observations.length;
      for (const observation of result.observations)
        normalizeMessagingObservation(state, observation);
      for (const diagnostic of result.diagnostics) {
        state.diagnostics.push(normalizeDiagnostic(state, "messaging", diagnostic));
      }
      addNoInvocationDiagnostic(
        state,
        "messaging",
        result.observations.length,
        state.observations.length - normalizedBefore,
        result.diagnostics,
      );
      collectors.push({
        collector: "messaging",
        inputMembers: selected.length,
        observations: state.observations.length - normalizedBefore,
        diagnostics: state.diagnostics.length - diagnosticsBefore,
      });
    }
  }

  if (collectors.length === 0) {
    state.diagnostics.push({
      level: "warning",
      code: "legacy/inventory/no_applicable_collector",
      message: `No ${collector === "auto" ? "supported" : collector} declarative artifacts were found.`,
      remediation:
        "Supply a hardened-expanded Java EE deployment, .NET configuration, or supported messaging export.",
    });
  }

  const snapshot = finalizeLegacyInventory({
    schemaVersion: 1,
    estate,
    artifacts,
    evidence: [...state.evidenceById.values()],
    observations: state.observations,
    diagnostics: state.diagnostics,
  });
  return { snapshot, candidates: reconcileLegacyInventory(snapshot), collectors };
}

/**
 * Consume an asynchronous acquisition stream with explicit backpressure and
 * byte limits, then run the same deterministic pure compiler. Members are
 * copied as they arrive so a caller cannot mutate previously yielded bytes.
 */
export async function collectLegacyInventoryStream(
  input: CollectLegacyInventoryStreamInput,
): Promise<LegacyInventoryResult> {
  const limits = {
    maxMembers: input.limits?.maxMembers ?? DEFAULT_STREAM_LIMITS.maxMembers,
    maxMemberBytes: input.limits?.maxMemberBytes ?? DEFAULT_STREAM_LIMITS.maxMemberBytes,
    maxTotalBytes: input.limits?.maxTotalBytes ?? DEFAULT_STREAM_LIMITS.maxTotalBytes,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`legacy inventory stream ${name} must be a positive safe integer`);
    }
  }
  const members: LegacySourceMember[] = [];
  let totalBytes = 0;
  for await (const member of input.members) {
    if (members.length >= limits.maxMembers) {
      throw new Error(`legacy inventory stream exceeds ${limits.maxMembers} members`);
    }
    if (!(member.bytes instanceof Uint8Array)) {
      throw new Error(`legacy source member '${member.path}' bytes must be a Uint8Array`);
    }
    if (member.bytes.byteLength > limits.maxMemberBytes) {
      throw new Error(
        `legacy source member '${member.path}' exceeds ${limits.maxMemberBytes} bytes`,
      );
    }
    totalBytes += member.bytes.byteLength;
    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(`legacy inventory stream exceeds ${limits.maxTotalBytes} total bytes`);
    }
    members.push({
      path: member.path,
      bytes: member.bytes.slice(),
      ...(member.source ? { source: { ...member.source } } : {}),
    });
  }
  const { limits: _limits, members: _stream, ...compileInput } = input;
  return collectLegacyInventory({ ...compileInput, members });
}

function normalizeMembers(input: readonly LegacySourceMember[]): LegacySourceMember[] {
  if (input.length === 0) throw new Error("legacy inventory requires at least one source member");
  const paths = new Set<string>();
  return [...input]
    .map((member) => {
      const path = LegacyRelativePath.parse(member.path);
      if (!(member.bytes instanceof Uint8Array)) {
        throw new Error(`legacy source member '${path}' bytes must be a Uint8Array`);
      }
      if (paths.has(path)) throw new Error(`duplicate legacy source member path '${path}'`);
      paths.add(path);
      return { path, bytes: member.bytes, ...(member.source ? { source: member.source } : {}) };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function selectJavaMembers(
  members: readonly LegacySourceMember[],
  explicit: boolean,
  state: NormalizationState,
): { path: string; content: string }[] {
  const relevant = members.filter((member) =>
    explicit ? /\.(?:java|xml|xmi)$/i.test(member.path) : javaMemberLooksRelevant(member),
  );
  return relevant.flatMap((member) => {
    try {
      return [
        {
          path: member.path,
          content: new TextDecoder("utf-8", { fatal: true }).decode(member.bytes),
        },
      ];
    } catch {
      state.diagnostics.push({
        level: "error",
        code: "legacy/java-ee/member_not_utf8",
        message: `Refused non-UTF-8 Java EE descriptor '${member.path}'.`,
        collectorId: "java-ee",
        artifactId: state.artifactsByPath.get(member.path)?.artifactId,
      });
      return [];
    }
  });
}

function selectDotnetMembers(
  members: readonly LegacySourceMember[],
  explicit: boolean,
): { path: string; bytes: Uint8Array }[] {
  return members
    .filter(
      (member) =>
        /\.(?:config|dll|exe|svc)$/i.test(member.path) ||
        (explicit
          ? /\.json$/i.test(member.path)
          : /(?:dotnet|iis|windows[-_. ]?service|deployment).+\.json$/i.test(member.path) ||
            dotnetMemberLooksRelevant(member)),
    )
    .map(({ path, bytes }) => ({ path, bytes }));
}

function selectMessagingMembers(
  members: readonly LegacySourceMember[],
  explicit: boolean,
): { path: string; bytes: Uint8Array }[] {
  return members
    .filter((member) => {
      if (/\.mqsc$/i.test(member.path)) return true;
      const structured = /\.(?:json|ya?ml|xml)$/i.test(member.path);
      return (
        structured &&
        (explicit ||
          /asyncapi|artemis|broker|rabbit|kafka|strimzi|schema[-_. ]?registry|ccdt|ibm[-_. ]?mq/i.test(
            member.path,
          ) ||
          messagingMemberLooksRelevant(member))
      );
    })
    .map(({ path, bytes }) => ({ path, bytes }));
}

function textPrefix(member: LegacySourceMember, maxBytes = 128 * 1024): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(member.bytes.subarray(0, maxBytes));
  } catch {
    return "";
  }
}

function javaMemberLooksRelevant(member: LegacySourceMember): boolean {
  if (
    /(?:application|web|ejb-jar|ra|weblogic[^/]*|jboss[^/]*|ibm-[^/]+|standalone|domain|server|resources|config)\.(?:xml|xmi)$/i.test(
      member.path,
    )
  ) {
    return true;
  }
  const content = textPrefix(member);
  return (
    (/\.java$/i.test(member.path) &&
      /@(?:[\w$.]+\.)?(?:Stateless|Stateful|Singleton|MessageDriven|Remote|Local)\b/u.test(
        content,
      )) ||
    /<(?:ejb-jar|application|web-app|connector|weblogic-|jboss|server|domain)\b/i.test(content)
  );
}

function dotnetMemberLooksRelevant(member: LegacySourceMember): boolean {
  if (!/\.(?:config|xml|json|svc)$/i.test(member.path)) return false;
  const content = textPrefix(member);
  return (
    /<system\.serviceModel\b|<serviceHostingEnvironment\b|<%@\s*ServiceHost\b/i.test(content) ||
    /"(?:windowsServices|iisSites|appPools|serviceActivations)"\s*:/i.test(content)
  );
}

function messagingMemberLooksRelevant(member: LegacySourceMember): boolean {
  const content = textPrefix(member);
  return (
    /(?:^|[\s{])(?:"?asyncapi"?|apiVersion)\s*[:=]/im.test(content) ||
    /kafka\.strimzi\.io\//i.test(content) ||
    /"(?:queues|exchanges|bindings|subjects|topics)"\s*:/i.test(content) ||
    /<(?:broker|address|queue)\b/i.test(content)
  );
}

function artifactRole(path: string): LegacyArtifactRole {
  const lower = path.toLowerCase();
  if (/\.(?:dll|exe|jar|war|ear|rar)$/.test(lower)) return "application_binary";
  if (/(?:application|web|ejb-jar|ra)\.xml$/.test(lower)) return "deployment_descriptor";
  if (/asyncapi|schema|avro|\.proto$|\.xsd$/.test(lower)) return "schema";
  if (/mqsc|ccdt|artemis|rabbit|kafka|broker/.test(lower)) return "broker_export";
  if (/\.config$|\.xml$|\.json$|\.ya?ml$/.test(lower)) return "runtime_configuration";
  return "other";
}

function mediaType(path: string): string {
  if (/\.json$/i.test(path)) return "application/json";
  if (/\.ya?ml$/i.test(path)) return "application/yaml";
  if (/\.xml$|\.config$|\.xmi$/i.test(path)) return "application/xml";
  if (/\.dll$|\.exe$/i.test(path)) return "application/vnd.microsoft.portable-executable";
  return "application/octet-stream";
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha256Bytes(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
