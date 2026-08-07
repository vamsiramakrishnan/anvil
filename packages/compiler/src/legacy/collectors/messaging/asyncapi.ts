import type {
  MessagingBindingKind,
  MessagingDiagnostic,
  MessagingJsonValue,
  MessagingObservation,
} from "./model.js";
import { boundedString, isRecord } from "./safety.js";

const BINDING_PRECEDENCE: readonly MessagingBindingKind[] = [
  "ibm_mq",
  "jms",
  "kafka",
  "amqp",
  "mqtt",
];

export function parseAsyncApi(
  value: unknown,
  origin: string,
): { observations: MessagingObservation[]; diagnostics: MessagingDiagnostic[] } {
  if (!isRecord(value) || !boundedString(value.asyncapi)) {
    return invalid(origin, "The document does not declare an AsyncAPI version.");
  }
  const info = isRecord(value.info) ? value.info : {};
  const namespace = boundedString(info.title) ? info.title : "unspecified";
  const diagnostics: MessagingDiagnostic[] = [];
  if (namespace === "unspecified") {
    diagnostics.push({
      level: "warning",
      code: "messaging/asyncapi_missing_title",
      message: `AsyncAPI document '${origin}' has no explicit info.title namespace.`,
      coordinate: { origin, pointer: "/info/title" },
    });
  }
  const major = Number(value.asyncapi.split(".")[0]);
  return major >= 3
    ? parseVersion3(value, origin, namespace, diagnostics)
    : parseVersion2(value, origin, namespace, diagnostics);
}

function parseVersion2(
  document: Record<string, unknown>,
  origin: string,
  namespace: string,
  diagnostics: MessagingDiagnostic[],
): { observations: MessagingObservation[]; diagnostics: MessagingDiagnostic[] } {
  const channels = isRecord(document.channels) ? document.channels : {};
  const observations: MessagingObservation[] = [];
  for (const [channelName, rawChannel] of Object.entries(channels)) {
    if (!isRecord(rawChannel)) continue;
    observations.push(channelObservation(namespace, channelName, rawChannel, origin));
    for (const action of ["publish", "subscribe"] as const) {
      const operation = rawChannel[action];
      if (!isRecord(operation)) continue;
      observations.push(
        operationObservation(
          namespace,
          channelName,
          action,
          operation,
          rawChannel,
          origin,
          `/channels/${escapePointer(channelName)}/${action}`,
        ),
      );
    }
  }
  if (observations.length === 0) diagnostics.push(noChannels(origin));
  return { observations, diagnostics };
}

function parseVersion3(
  document: Record<string, unknown>,
  origin: string,
  namespace: string,
  diagnostics: MessagingDiagnostic[],
): { observations: MessagingObservation[]; diagnostics: MessagingDiagnostic[] } {
  const channels = isRecord(document.channels) ? document.channels : {};
  const observations: MessagingObservation[] = [];
  for (const [channelKey, rawChannel] of Object.entries(channels)) {
    if (!isRecord(rawChannel)) continue;
    const address = boundedString(rawChannel.address) ? rawChannel.address : channelKey;
    observations.push(channelObservation(namespace, address, rawChannel, origin, channelKey));
  }
  const operations = isRecord(document.operations) ? document.operations : {};
  for (const [operationKey, rawOperation] of Object.entries(operations)) {
    if (!isRecord(rawOperation) || !boundedString(rawOperation.action)) continue;
    const channelRef = isRecord(rawOperation.channel) ? rawOperation.channel.$ref : undefined;
    const channelKey = localReferenceName(channelRef) ?? "unspecified";
    const channel = isRecord(channels[channelKey]) ? channels[channelKey] : {};
    const channelName = boundedString(channel.address) ? channel.address : channelKey;
    observations.push(
      operationObservation(
        namespace,
        channelName,
        rawOperation.action,
        { ...rawOperation, operationId: rawOperation.operationId ?? operationKey },
        channel,
        origin,
        `/operations/${escapePointer(operationKey)}`,
      ),
    );
  }
  if (observations.length === 0) diagnostics.push(noChannels(origin));
  return { observations, diagnostics };
}

function channelObservation(
  namespace: string,
  channelName: string,
  channel: Record<string, unknown>,
  origin: string,
  channelKey = channelName,
): MessagingObservation {
  const bindingNames = recordKeys(channel.bindings);
  const messageNames = isRecord(channel.messages) ? Object.keys(channel.messages).sort() : [];
  const bindingConfiguration = safeBindingConfiguration(channel.bindings);
  return {
    id: "",
    kind: "destination",
    coordinate: `asyncapi:${namespace}:channel:${channelName}`,
    name: channelName,
    binding: {
      kind: bindingKind(bindingNames),
      config: {
        namespace,
        channelKey,
        address: channelName,
        ...(bindingNames.length > 0 ? { bindingNames } : {}),
        ...(Object.keys(bindingConfiguration).length > 0 ? { bindingConfiguration } : {}),
        ...(messageNames.length > 0 ? { messageNames } : {}),
      },
    },
    evidence: [{ origin, pointer: `/channels/${escapePointer(channelKey)}` }],
    confidence: "declared",
  };
}

function operationObservation(
  namespace: string,
  channelName: string,
  action: string,
  operation: Record<string, unknown>,
  channel: Record<string, unknown>,
  origin: string,
  pointer: string,
): MessagingObservation {
  const operationId = boundedString(operation.operationId) ? operation.operationId : action;
  const bindingNames = [...recordKeys(channel.bindings), ...recordKeys(operation.bindings)].sort();
  const messageRefs = extractMessageRefs(operation.message ?? operation.messages);
  const channelBindingConfiguration = safeBindingConfiguration(channel.bindings);
  const operationBindingConfiguration = safeBindingConfiguration(operation.bindings);
  const config: Record<string, MessagingJsonValue> = {
    namespace,
    channel: channelName,
    action,
    operationId,
    ...(bindingNames.length > 0 ? { bindingNames: [...new Set(bindingNames)] } : {}),
    ...(messageRefs.length > 0 ? { messageRefs } : {}),
    ...(Object.keys(channelBindingConfiguration).length > 0 ? { channelBindingConfiguration } : {}),
    ...(Object.keys(operationBindingConfiguration).length > 0
      ? { operationBindingConfiguration }
      : {}),
  };
  return {
    id: "",
    kind: "message_operation",
    coordinate: `asyncapi:${namespace}:operation:${operationId}`,
    name: operationId,
    binding: { kind: bindingKind(bindingNames), config },
    evidence: [{ origin, pointer }],
    confidence: "declared",
  };
}

function extractMessageRefs(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.oneOf)
      ? value.oneOf
      : value === undefined
        ? []
        : [value];
  return values
    .flatMap((message) => {
      if (!isRecord(message)) return [];
      if (boundedString(message.$ref)) return [message.$ref];
      if (boundedString(message.name)) return [message.name];
      return [];
    })
    .sort();
}

function bindingKind(bindingNames: readonly string[]): MessagingBindingKind {
  const normalized = new Set(bindingNames.map((name) => name.toLowerCase().replace(/[-_]/g, "")));
  if (normalized.has("ibmmq")) return "ibm_mq";
  return (
    BINDING_PRECEDENCE.find((candidate) => normalized.has(candidate.replace("_", ""))) ?? "asyncapi"
  );
}

function recordKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).sort() : [];
}

function safeBindingConfiguration(value: unknown): Record<string, MessagingJsonValue> {
  if (!isRecord(value)) return {};
  const allowed = new Set([
    "bindingVersion",
    "ccsid",
    "destination",
    "destinationType",
    "exchange",
    "groupId",
    "is",
    "queue",
    "queueManager",
    "routingKey",
    "topic",
    "type",
  ]);
  const out: Record<string, MessagingJsonValue> = {};
  for (const [bindingName, rawConfiguration] of Object.entries(value).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!isRecord(rawConfiguration)) continue;
    const safe: Record<string, MessagingJsonValue> = {};
    for (const [key, child] of Object.entries(rawConfiguration)) {
      if (allowed.has(key) && ["string", "number", "boolean"].includes(typeof child)) {
        safe[key] = child as string | number | boolean;
      }
    }
    if (Object.keys(safe).length > 0) out[bindingName] = safe;
  }
  return out;
}

function localReferenceName(value: unknown): string | undefined {
  if (!boundedString(value)) return undefined;
  const segments = value.split("/");
  return segments[segments.length - 1];
}

function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function noChannels(origin: string): MessagingDiagnostic {
  return {
    level: "warning",
    code: "messaging/asyncapi_no_operations",
    message: `AsyncAPI document '${origin}' declares no supported channels or operations.`,
    coordinate: { origin },
  };
}

function invalid(
  origin: string,
  message: string,
): { observations: MessagingObservation[]; diagnostics: MessagingDiagnostic[] } {
  return {
    observations: [],
    diagnostics: [
      {
        level: "error",
        code: "messaging/invalid_asyncapi",
        message,
        coordinate: { origin },
      },
    ],
  };
}
