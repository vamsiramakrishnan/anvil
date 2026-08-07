import { createHash } from "node:crypto";
import { hashCanonical } from "@anvil/air";
import { z } from "zod";
import {
  collectDotnetLegacy,
  type DotnetDiagnostic,
  type DotnetObservation,
} from "./collectors/dotnet/index.js";
import {
  collectJavaEeLegacy,
  type JavaEeDiagnostic,
  type JavaEeObservation,
} from "./collectors/java-ee/index.js";
import {
  collectMessagingLegacy,
  type MessagingDiagnostic,
  type MessagingJsonValue,
  type MessagingObservation,
} from "./collectors/messaging/index.js";
import {
  createLegacyArtifact,
  createLegacyEvidence,
  createLegacyObservation,
  EvidenceSourceKind,
  finalizeLegacyInventory,
  type LegacyArtifactRecord,
  type LegacyArtifactRole,
  type LegacyCapabilityCandidate,
  type LegacyClaim,
  type LegacyCollectorDiagnostic,
  type LegacyDeploymentCoordinate,
  LegacyEstate,
  type LegacyEvidenceBasis,
  type LegacyEvidenceRecord,
  LegacyIdentifier,
  type LegacyInventorySnapshot,
  type LegacyInvocation,
  LegacyRelativePath,
  reconcileLegacyInventory,
} from "./core/index.js";

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

interface NormalizationState {
  artifactsByPath: Map<string, LegacyArtifactRecord>;
  evidenceById: Map<string, LegacyEvidenceRecord>;
  observations: ReturnType<typeof createLegacyObservation>[];
  diagnostics: LegacyCollectorDiagnostic[];
  coordinate: Omit<LegacyDeploymentCoordinate, "platform" | "module" | "component">;
}

interface EvidenceCoordinate {
  path: string;
  pointer?: string;
  span?: { start: number; end: number };
}

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

function normalizeJavaObservation(
  state: NormalizationState,
  observation: JavaEeObservation,
  allObservations: readonly JavaEeObservation[],
  effectivePlatform: JavaEeObservation["platform"] | undefined,
): void {
  const evidenceIds = evidenceFor(
    state,
    "java-ee",
    observation.evidence.map((coordinate) => ({
      path: coordinate.path,
      pointer: coordinate.pointer,
    })),
    "declared",
  );
  if (evidenceIds.length === 0) return;
  const logicalName =
    observation.binding?.logicalName ?? observation.component.name ?? observation.id;
  const claims = technicalClaims(observation.component.name, evidenceIds, "declared");
  addBindingClaim(claims, observation.binding?.physicalName, evidenceIds, "configured");

  if (observation.component.kind === "message_driven_bean") {
    emitObservation(state, {
      collectorId: "java-ee",
      platform: effectivePlatform ?? observation.platform,
      module: observation.module,
      component: logicalName,
      invocation: {
        kind: "message",
        protocol: "jms",
        destination: logicalName,
        direction: "consume",
        ...(observation.attributes?.messagingType
          ? { messageType: observation.attributes.messagingType }
          : {}),
      },
      claims: [...claims, claim("interaction_pattern", "consume", evidenceIds, "declared")],
      evidenceIds,
    });
    return;
  }

  if (observation.component.kind === "session_bean" && !observation.component.localOnly) {
    const interfaces = [
      ...(observation.component.interfaces?.remote ?? []),
      ...(observation.component.interfaces?.home ?? []),
    ];
    const bindingObservations = allObservations.filter(
      (candidate) =>
        candidate !== observation &&
        candidate.component.kind === "session_bean" &&
        candidate.component.name === observation.component.name &&
        candidate.module === observation.module &&
        candidate.binding?.physicalName,
    );
    const bindingEvidence = bindingObservations.flatMap((candidate) =>
      evidenceFor(
        state,
        "java-ee",
        candidate.evidence.map((coordinate) => ({
          path: coordinate.path,
          pointer: coordinate.pointer,
        })),
        "configured",
      ),
    );
    const remoteEvidenceIds = [...new Set([...evidenceIds, ...bindingEvidence])].sort();
    const remoteClaims = [...claims];
    for (const candidate of bindingObservations) {
      const candidateEvidence = evidenceFor(
        state,
        "java-ee",
        candidate.evidence.map((coordinate) => ({
          path: coordinate.path,
          pointer: coordinate.pointer,
        })),
        "configured",
      );
      addBindingClaim(
        remoteClaims,
        candidate.binding?.physicalName,
        candidateEvidence,
        "configured",
      );
    }
    for (const remoteInterface of interfaces) {
      emitObservation(state, {
        collectorId: "java-ee",
        platform: effectivePlatform ?? observation.platform,
        module: observation.module,
        component: logicalName,
        invocation: {
          kind: "remote_method",
          protocol: "ejb_rmi",
          interface: remoteInterface,
        },
        claims: [
          ...remoteClaims,
          claim("interaction_pattern", "request_response", evidenceIds, "declared"),
        ],
        evidenceIds: remoteEvidenceIds,
      });
    }
    return;
  }

  if (
    observation.component.kind === "connection_definition" ||
    observation.binding?.kind === "resource_adapter"
  ) {
    emitObservation(state, {
      collectorId: "java-ee",
      platform: effectivePlatform ?? observation.platform,
      module: observation.module,
      component: logicalName,
      invocation: {
        kind: "resource_adapter",
        adapterRef:
          observation.binding?.physicalName ?? observation.component.className ?? logicalName,
        connectionFactoryRef:
          observation.binding?.connectionFactoryName ??
          observation.binding?.logicalName ??
          logicalName,
      },
      claims,
      evidenceIds,
    });
  }
}

function normalizeDotnetObservation(
  state: NormalizationState,
  observation: DotnetObservation,
): void {
  if (observation.kind !== "service_endpoint") {
    evidenceFor(
      state,
      "dotnet",
      observation.evidence.map((coordinate) => ({
        path: coordinate.origin,
        ...(coordinate.pointer ? { pointer: coordinate.pointer } : {}),
      })),
      "configured",
    );
    return;
  }
  const evidenceIds = evidenceFor(
    state,
    "dotnet",
    observation.evidence.map((coordinate) => ({
      path: coordinate.origin,
      ...(coordinate.pointer ? { pointer: coordinate.pointer } : {}),
    })),
    "configured",
  );
  if (evidenceIds.length === 0) return;
  const claims = technicalClaims(observation.name, evidenceIds, "configured");
  const config = observation.binding.config;
  const address = stringValue(config.address);
  addBindingClaim(claims, address, evidenceIds, "configured");
  addErrorClaim(claims, config, evidenceIds);

  if (observation.binding.kind === "msmq") {
    emitObservation(state, {
      collectorId: "dotnet",
      platform: "dotnet-framework",
      component: observation.coordinate,
      invocation: {
        kind: "message",
        protocol: "msmq",
        destination: stringValue(config.endpointName) ?? observation.name,
        direction: "unknown",
      },
      claims,
      evidenceIds,
    });
    return;
  }
  const contract = stringValue(config.contract) ?? observation.name;
  emitObservation(state, {
    collectorId: "dotnet",
    platform: "dotnet-framework",
    component: observation.coordinate,
    invocation: { kind: "remote_method", protocol: "wcf", interface: contract },
    claims: [
      ...claims,
      claim("interaction_pattern", "request_response", evidenceIds, "configured"),
    ],
    evidenceIds,
  });
}

function normalizeMessagingObservation(
  state: NormalizationState,
  observation: MessagingObservation,
): void {
  const evidenceIds = evidenceFor(
    state,
    "messaging",
    observation.evidence.map((coordinate) => ({
      path: coordinate.origin,
      ...(coordinate.pointer ? { pointer: coordinate.pointer } : {}),
      ...(coordinate.span ? { span: coordinate.span } : {}),
    })),
    "configured",
  );
  if (evidenceIds.length === 0) return;
  if (observation.kind === "schema_subject") return;
  const config = observation.binding.config;
  const reply = stringValue(config.replyChannel) ?? stringValue(config.replyAddress);
  const direction = reply ? "request_reply" : messagingDirection(config.action);
  const declaredTopics = stringArray(config.topics);
  const logicalDestinations =
    declaredTopics.length > 0
      ? declaredTopics
      : [
          stringValue(config.channelKey) ??
            stringValue(config.channel) ??
            stringValue(config.topic) ??
            observation.name,
        ];
  for (const logicalDestination of logicalDestinations) {
    const claims = technicalClaims(observation.name, evidenceIds, "configured");
    addBindingClaim(
      claims,
      stringValue(config.address) ??
        (declaredTopics.length === 0 ? stringValue(config.topic) : logicalDestination) ??
        stringValue(config.topicPattern),
      evidenceIds,
      "configured",
    );
    addSchemaClaims(claims, config, evidenceIds);
    addDeliveryClaims(claims, config, evidenceIds);
    addErrorClaim(claims, config, evidenceIds);
    if (reply) {
      claims.push(claim("interaction_pattern", "request_reply", evidenceIds, "declared"));
    }
    emitObservation(state, {
      collectorId: "messaging",
      platform: observation.binding.kind,
      component: observation.coordinate,
      invocation: {
        kind: "message",
        protocol: messagingProtocol(observation.binding.kind),
        destination: bounded(logicalDestination, 512),
        direction,
        ...messageType(config),
      },
      claims,
      evidenceIds,
    });
  }
}

function emitObservation(
  state: NormalizationState,
  input: {
    collectorId: string;
    platform: string;
    module?: string;
    component: string;
    invocation: LegacyInvocation;
    claims: LegacyClaim[];
    evidenceIds: string[];
  },
): void {
  state.observations.push(
    createLegacyObservation({
      schemaVersion: 1,
      collectorId: input.collectorId,
      coordinate: {
        ...state.coordinate,
        platform: coordinateId(input.platform, "platform"),
        module: coordinateId(input.module ?? state.coordinate.application, "module"),
        component: coordinateId(input.component, "component"),
      },
      invocation: input.invocation,
      claims: input.claims,
      evidenceIds: input.evidenceIds,
    }),
  );
}

function evidenceFor(
  state: NormalizationState,
  collectorId: string,
  coordinates: readonly EvidenceCoordinate[],
  basis: LegacyEvidenceBasis,
): string[] {
  const evidenceIds: string[] = [];
  for (const coordinate of coordinates) {
    const artifact = state.artifactsByPath.get(coordinate.path);
    if (!artifact) continue;
    const evidence = createLegacyEvidence({
      schemaVersion: 1,
      artifactId: artifact.artifactId,
      sourceKind: artifact.source.kind,
      collectorId,
      basis,
      coordinate: {
        path: coordinate.path,
        ...(coordinate.pointer ? { pointer: bounded(coordinate.pointer, 2048) } : {}),
        ...(coordinate.span ? { span: coordinate.span } : {}),
      },
    });
    state.evidenceById.set(evidence.evidenceId, evidence);
    evidenceIds.push(evidence.evidenceId);
  }
  return [...new Set(evidenceIds)].sort();
}

function technicalClaims(
  name: string,
  evidenceIds: string[],
  basis: LegacyEvidenceBasis,
): LegacyClaim[] {
  return [claim("technical_name", bounded(name, 2048), evidenceIds, basis)];
}

function addBindingClaim(
  claims: LegacyClaim[],
  value: string | undefined,
  evidenceIds: string[],
  basis: LegacyEvidenceBasis,
): void {
  if (value) claims.push(claim("binding_target", bounded(value, 2048), evidenceIds, basis));
}

function addSchemaClaims(
  claims: LegacyClaim[],
  config: Readonly<Record<string, MessagingJsonValue>>,
  evidenceIds: string[],
): void {
  const refs = stringArray(
    config.messageRefs ?? config.messageNames ?? config.schemaSubjects ?? config.subject,
  ).slice(0, 64);
  if (refs.length > 0) claims.push(claim("input_schema", refs, evidenceIds, "declared"));
  const replyRefs = stringArray(config.replyMessageRefs).slice(0, 64);
  if (replyRefs.length > 0) {
    claims.push(claim("output_schema", replyRefs, evidenceIds, "declared"));
  }
}

function addDeliveryClaims(
  claims: LegacyClaim[],
  config: Readonly<Record<string, MessagingJsonValue>>,
  evidenceIds: string[],
): void {
  const facts: string[] = [];
  if (config.exactlyOnce === true || config.exactlyOnce === "true")
    facts.push("exactly_once_configured");
  if (config.durable === true || config.durable === "true") facts.push("durable_configured");
  if (config.defpsist === "YES") facts.push("persistent_by_default");
  if (facts.length > 0) claims.push(claim("delivery_guarantee", facts, evidenceIds, "configured"));
}

function addErrorClaim(
  claims: LegacyClaim[],
  config: Readonly<Record<string, MessagingJsonValue>> | Readonly<Record<string, unknown>>,
  evidenceIds: string[],
): void {
  const value = stringValue(config.deadLetterQueue) ?? stringValue(config.receiveErrorHandling);
  if (value) claims.push(claim("error_semantics", bounded(value, 2048), evidenceIds, "configured"));
}

function claim(
  dimension: LegacyClaim["dimension"],
  value: LegacyClaim["value"],
  evidenceIds: string[],
  basis: LegacyEvidenceBasis,
): LegacyClaim {
  return { dimension, value, evidenceIds, basis };
}

function messagingDirection(
  value: MessagingJsonValue | undefined,
): Extract<LegacyInvocation, { kind: "message" }>["direction"] {
  if (value === "publish") return "publish";
  if (value === "subscribe") return "subscribe";
  if (value === "send" || value === "produce") return "produce";
  if (value === "receive" || value === "consume") return "consume";
  return "unknown";
}

function messagingProtocol(
  kind: MessagingObservation["binding"]["kind"],
): Extract<LegacyInvocation, { kind: "message" }>["protocol"] {
  if (kind === "asyncapi" || kind === "mqtt") return "other";
  if (kind === "rabbitmq") return "amqp";
  return kind;
}

function messageType(config: Readonly<Record<string, MessagingJsonValue>>): {
  messageType?: string;
} {
  const candidates = stringArray(config.messageIds ?? config.messageRefs ?? config.messageNames);
  return candidates.length === 1 ? { messageType: candidates[0] } : {};
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

function addNoInvocationDiagnostic(
  state: NormalizationState,
  collectorId: Exclude<LegacyCollectorKind, "auto">,
  rawObservations: number,
  normalizedObservations: number,
  collectorDiagnostics: readonly { level: "info" | "warning" | "error" }[],
): void {
  if (
    rawObservations === 0 ||
    normalizedObservations > 0 ||
    collectorDiagnostics.some((diagnostic) => diagnostic.level !== "info")
  ) {
    return;
  }
  const diagnostic: LegacyCollectorDiagnostic =
    collectorId === "java-ee"
      ? {
          level: "warning",
          code: "legacy/java-ee/no_invocation_candidate",
          message:
            "Java EE declarations were retained as evidence, but none proved a remote, messaging, or resource-adapter invocation.",
          remediation:
            "Supply an explicit remote interface, message destination, resource-adapter binding, or deployed vendor mapping.",
          collectorId,
        }
      : collectorId === "dotnet"
        ? {
            level: "warning",
            code: "legacy/dotnet/no_invocation_candidate",
            message:
              ".NET deployment declarations were retained as evidence, but none proved a callable WCF or MSMQ contract.",
            remediation:
              "Supply an explicit endpoint contract or bounded static contract metadata; hosting identity alone is insufficient.",
            collectorId,
          }
        : {
            level: "warning",
            code: "legacy/messaging/no_invocation_candidate",
            message:
              "Messaging metadata was retained as evidence, but none proved a destination or message operation.",
            remediation:
              "Supply a topic, queue, routing, producer/consumer operation, or a separate binding that links schema metadata to one.",
            collectorId,
          };
  state.diagnostics.push(diagnostic);
}

function normalizeDiagnostic(
  state: NormalizationState,
  collectorId: string,
  diagnostic: JavaEeDiagnostic | DotnetDiagnostic | MessagingDiagnostic,
): LegacyCollectorDiagnostic {
  const rawCoordinate =
    "path" in (diagnostic.coordinate ?? {})
      ? (diagnostic.coordinate as { path: string }).path
      : "origin" in (diagnostic.coordinate ?? {})
        ? (diagnostic.coordinate as { origin: string }).origin
        : undefined;
  const code = diagnostic.code
    .toLowerCase()
    .replace(/[^a-z0-9_/-]+/g, "_")
    .replace(/^\/+|\/+$/g, "");
  return {
    level: diagnostic.level,
    code: `legacy/${code}`,
    message: bounded(diagnostic.message, 2048),
    collectorId,
    ...(rawCoordinate && state.artifactsByPath.has(rawCoordinate)
      ? { artifactId: state.artifactsByPath.get(rawCoordinate)?.artifactId }
      : {}),
  };
}

function coordinateId(value: string, prefix: string): string {
  const parsed = LegacyIdentifier.safeParse(value);
  return parsed.success ? parsed.data : `${prefix}-${hashCanonical(value).slice(0, 24)}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return [
    ...new Set(
      values
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => bounded(item.trim(), 512)),
    ),
  ].sort();
}

function bounded(value: string, max: number): string {
  let printable = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    printable += code <= 31 || code === 127 ? " " : character;
  }
  const clean = printable.trim();
  return (clean || "unspecified").slice(0, max).trim();
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
