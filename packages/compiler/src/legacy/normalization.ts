import { hashCanonical } from "@anvil/air";
import type { DotnetDiagnostic, DotnetObservation } from "./collectors/dotnet/index.js";
import type { JavaEeDiagnostic, JavaEeObservation } from "./collectors/java-ee/index.js";
import type {
  MessagingDiagnostic,
  MessagingJsonValue,
  MessagingObservation,
} from "./collectors/messaging/index.js";
import {
  createLegacyEvidence,
  createLegacyObservation,
  type LegacyArtifactRecord,
  type LegacyClaim,
  type LegacyCollectorDiagnostic,
  type LegacyDeploymentCoordinate,
  type LegacyEvidenceBasis,
  type LegacyEvidenceRecord,
  LegacyIdentifier,
  type LegacyInvocation,
} from "./core/index.js";

export interface NormalizationState {
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

export function normalizeJavaObservation(
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

export function normalizeDotnetObservation(
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

export function normalizeMessagingObservation(
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

export function addNoInvocationDiagnostic(
  state: NormalizationState,
  collectorId: "java-ee" | "dotnet" | "messaging",
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

export function normalizeDiagnostic(
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
