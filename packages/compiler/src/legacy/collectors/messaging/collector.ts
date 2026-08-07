import { createHash } from "node:crypto";
import { parseArtemisXml } from "./artemis.js";
import { parseAsyncApi } from "./asyncapi.js";
import { parseCcdt, parseMqsc } from "./ibm-mq.js";
import { detectKafkaDocument, parseKafkaManifest } from "./kafka.js";
import type {
  MessagingArtifactInput,
  MessagingCollectorResult,
  MessagingDiagnostic,
  MessagingJsonValue,
  MessagingObservation,
} from "./model.js";
import { hasRabbitMqNonTopologySections, parseRabbitMqDefinitions } from "./rabbitmq.js";
import {
  acceptMessagingArtifacts,
  containsForbiddenXml,
  containsSecretLikeValue,
  containsSecretLikeXml,
  isRecord,
  parseJsonOrYaml,
} from "./safety.js";

export function collectMessagingLegacy(
  inputs: readonly MessagingArtifactInput[],
): MessagingCollectorResult {
  const accepted = acceptMessagingArtifacts(inputs);
  const diagnostics = [...accepted.diagnostics];
  const observations: MessagingObservation[] = [];

  for (const artifact of accepted.artifacts) {
    if (/\.mqsc$/i.test(artifact.path)) {
      const parsed = parseMqsc(artifact.text, artifact.path);
      observations.push(...parsed.observations);
      diagnostics.push(...parsed.diagnostics);
      continue;
    }
    if (/\.xml$/i.test(artifact.path)) {
      if (containsForbiddenXml(artifact.text)) {
        diagnostics.push(refusal("messaging/forbidden_xml_construct", artifact.path));
        continue;
      }
      if (containsSecretLikeXml(artifact.text)) {
        diagnostics.push(refusal("messaging/secret_like_value", artifact.path));
        continue;
      }
      const parsed = parseArtemisXml(artifact.text, artifact.path);
      observations.push(...parsed.observations);
      diagnostics.push(...parsed.diagnostics);
      continue;
    }

    const parsedDocument = parseJsonOrYaml(artifact.text);
    if (!parsedDocument.ok) {
      diagnostics.push({
        level: "error",
        code: "messaging/malformed_document",
        message: `Could not parse malformed messaging artifact '${artifact.path}'.`,
        coordinate: { origin: artifact.path },
      });
      continue;
    }
    const formats = detectedFormats(parsedDocument.value);
    const containsSensitiveValue = containsSecretLikeValue(parsedDocument.value);
    const safelyProjectable =
      formats.length === 1 &&
      formats[0] !== undefined &&
      ["asyncapi", "rabbitmq", "kafka"].includes(formats[0]);
    if (containsSensitiveValue && !safelyProjectable) {
      diagnostics.push(refusal("messaging/secret_like_value", artifact.path));
      continue;
    }
    if (formats.length !== 1) {
      diagnostics.push({
        level: formats.length === 0 ? "warning" : "error",
        code:
          formats.length === 0
            ? "messaging/unsupported_artifact"
            : "messaging/ambiguous_artifact_format",
        message:
          formats.length === 0
            ? `Recorded but did not interpret unsupported messaging artifact '${artifact.path}'.`
            : `Refused '${artifact.path}' because it matches multiple messaging export formats: ` +
              formats.join(", "),
        coordinate: { origin: artifact.path },
      });
      continue;
    }
    const format = formats[0];
    if (format === "asyncapi") {
      const parsed = parseAsyncApi(parsedDocument.value, artifact.path);
      observations.push(...parsed.observations);
      diagnostics.push(...parsed.diagnostics);
      if (containsSensitiveValue) diagnostics.push(safeProjection("asyncapi", artifact.path));
    } else if (format === "rabbitmq") {
      const projected = parseRabbitMqDefinitions(parsedDocument.value, artifact.path);
      if (containsSensitiveValue && projected.length === 0) {
        diagnostics.push(refusal("messaging/secret_like_value", artifact.path));
        continue;
      }
      observations.push(...projected);
      if (containsSensitiveValue || hasRabbitMqNonTopologySections(parsedDocument.value)) {
        diagnostics.push(safeProjection("rabbitmq", artifact.path));
      }
    } else if (format === "kafka") {
      const parsed = parseKafkaManifest(parsedDocument.value, artifact.path);
      if (containsSensitiveValue && parsed.observations.length === 0) {
        diagnostics.push(refusal("messaging/secret_like_value", artifact.path));
        continue;
      }
      observations.push(...parsed.observations);
      diagnostics.push(...parsed.diagnostics);
      if (containsSensitiveValue) diagnostics.push(safeProjection("kafka", artifact.path));
    } else if (format === "ccdt") {
      const parsed = parseCcdt(parsedDocument.value, artifact.path);
      observations.push(...parsed.observations);
      diagnostics.push(...parsed.diagnostics);
    }
  }

  const reconciled = reconcileObservations(observations, diagnostics);
  return {
    collector: { kind: "messaging", schemaVersion: 1 },
    evidence: accepted.artifacts.map((artifact) => artifact.evidence),
    observations: reconciled.sort((a, b) =>
      `${a.coordinate}:${a.id}`.localeCompare(`${b.coordinate}:${b.id}`),
    ),
    diagnostics: deduplicateDiagnostics(diagnostics).sort(diagnosticOrder),
  };
}

type MessagingFormat = "asyncapi" | "rabbitmq" | "kafka" | "ccdt";

function detectedFormats(value: unknown): MessagingFormat[] {
  const formats: MessagingFormat[] = [];
  if (isRecord(value)) {
    if (typeof value.asyncapi === "string") formats.push("asyncapi");
    if (
      Array.isArray(value.queues) ||
      Array.isArray(value.exchanges) ||
      Array.isArray(value.bindings)
    ) {
      formats.push("rabbitmq");
    }
    const channels = Array.isArray(value.channels)
      ? value.channels
      : Array.isArray(value.channel)
        ? value.channel
        : [];
    if (channels.some((channel) => isRecord(channel) && isCcdtChannel(channel)))
      formats.push("ccdt");
  }
  if (detectKafkaDocument(value)) formats.push("kafka");
  return formats;
}

function isCcdtChannel(channel: Record<string, unknown>): boolean {
  return (
    isRecord(channel.clientConnection) ||
    typeof channel.channelName === "string" ||
    typeof channel.qmgrName === "string"
  );
}

function reconcileObservations(
  observations: readonly MessagingObservation[],
  diagnostics: MessagingDiagnostic[],
): MessagingObservation[] {
  const byCoordinate = new Map<string, MessagingObservation[]>();
  for (const raw of observations) {
    const observation = withId(raw);
    const existing = byCoordinate.get(observation.coordinate) ?? [];
    const identical = existing.find(
      (candidate) => canonical(candidate.binding) === canonical(observation.binding),
    );
    if (identical) {
      identical.evidence = uniqueEvidence([...identical.evidence, ...observation.evidence]);
    } else {
      existing.push(observation);
      byCoordinate.set(observation.coordinate, existing);
    }
  }
  for (const [coordinate, candidates] of byCoordinate) {
    if (candidates.length < 2) continue;
    diagnostics.push({
      level: "error",
      code: "messaging/ambiguous_coordinate",
      message:
        `Retained ${candidates.length} conflicting declarations for '${coordinate}'; ` +
        "downstream reconciliation must not select one implicitly.",
      coordinate: candidates[0]?.evidence[0],
    });
  }
  return [...byCoordinate.values()].flat();
}

function withId(observation: MessagingObservation): MessagingObservation {
  const hash = createHash("sha256")
    .update(canonical({ coordinate: observation.coordinate, binding: observation.binding }))
    .digest("hex")
    .slice(0, 24);
  return { ...observation, id: `legacy_${hash}` };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value as MessagingJsonValue) ?? "null";
}

function uniqueEvidence(
  evidence: MessagingObservation["evidence"],
): MessagingObservation["evidence"] {
  return [
    ...new Map(
      evidence.map((item) => [
        `${item.origin}:${item.pointer ?? ""}:${item.span?.start ?? ""}`,
        item,
      ]),
    ).values(),
  ].sort((a, b) => `${a.origin}:${a.pointer}`.localeCompare(`${b.origin}:${b.pointer}`));
}

function refusal(code: string, origin: string): MessagingDiagnostic {
  return {
    level: "error",
    code,
    message: `Refused '${origin}'; collectors never retain active secrets or unsafe XML entities.`,
    coordinate: { origin },
  };
}

function safeProjection(
  format: "asyncapi" | "kafka" | "rabbitmq",
  origin: string,
): MessagingDiagnostic {
  return {
    level: "info",
    code: `messaging/${format}_safe_projection_applied`,
    message: `Collected only allowlisted ${format} topology from '${origin}'; non-topology fields were ignored.`,
    coordinate: { origin },
  };
}

function deduplicateDiagnostics(diagnostics: MessagingDiagnostic[]): MessagingDiagnostic[] {
  return [
    ...new Map(
      diagnostics.map((diagnostic) => [
        `${diagnostic.code}:${diagnostic.coordinate?.origin ?? ""}:${diagnostic.message}`,
        diagnostic,
      ]),
    ).values(),
  ];
}

function diagnosticOrder(a: MessagingDiagnostic, b: MessagingDiagnostic): number {
  return `${a.coordinate?.origin ?? ""}:${a.code}`.localeCompare(
    `${b.coordinate?.origin ?? ""}:${b.code}`,
  );
}
