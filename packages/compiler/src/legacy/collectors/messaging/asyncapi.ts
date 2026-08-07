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
    observations.push(channelObservation(namespace, channelName, channelName, rawChannel, origin));
    for (const action of ["publish", "subscribe"] as const) {
      const operation = rawChannel[action];
      if (!isRecord(operation)) continue;
      observations.push(
        operationObservation(
          namespace,
          channelName,
          channelName,
          action,
          operation,
          rawChannel,
          document,
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
    const address = boundedString(rawChannel.address)
      ? rawChannel.address
      : rawChannel.address === null
        ? undefined
        : channelKey;
    observations.push(channelObservation(namespace, channelKey, address, rawChannel, origin));
  }
  const operations = isRecord(document.operations) ? document.operations : {};
  for (const [operationKey, rawOperation] of Object.entries(operations)) {
    if (!isRecord(rawOperation) || !boundedString(rawOperation.action)) continue;
    const channelRef = isRecord(rawOperation.channel) ? rawOperation.channel.$ref : undefined;
    const channelKey = localReferenceName(channelRef) ?? "unspecified";
    const channel = isRecord(channels[channelKey]) ? channels[channelKey] : {};
    const address = boundedString(channel.address)
      ? channel.address
      : channel.address === null
        ? undefined
        : channelKey;
    if (channelKey === "unspecified") {
      diagnostics.push({
        level: "warning",
        code: "messaging/asyncapi_unresolved_channel_reference",
        message: `AsyncAPI operation '${operationKey}' in '${origin}' has no resolvable local channel reference.`,
        coordinate: { origin, pointer: `/operations/${escapePointer(operationKey)}/channel` },
      });
    }
    observations.push(
      operationObservation(
        namespace,
        channelKey,
        address,
        rawOperation.action,
        { ...rawOperation, operationId: rawOperation.operationId ?? operationKey },
        channel,
        document,
        origin,
        `/operations/${escapePointer(operationKey)}`,
        operationKey,
      ),
    );
  }
  if (observations.length === 0) diagnostics.push(noChannels(origin));
  return { observations, diagnostics };
}

function channelObservation(
  namespace: string,
  channelKey: string,
  address: string | undefined,
  channel: Record<string, unknown>,
  origin: string,
): MessagingObservation {
  const bindingNames = recordKeys(channel.bindings);
  const messageNames = isRecord(channel.messages) ? Object.keys(channel.messages).sort() : [];
  const bindingConfiguration = safeBindingConfiguration(channel.bindings);
  return {
    id: "",
    kind: "destination",
    coordinate: `asyncapi:${namespace}:channel:${channelKey}`,
    name: channelKey,
    binding: {
      kind: bindingKind(bindingNames),
      config: {
        namespace,
        channel: channelKey,
        channelKey,
        ...(address ? { address } : {}),
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
  channelKey: string,
  address: string | undefined,
  action: string,
  operation: Record<string, unknown>,
  channel: Record<string, unknown>,
  document: Record<string, unknown>,
  origin: string,
  pointer: string,
  operationKey = `${channelKey}:${action}`,
): MessagingObservation {
  const operationId = boundedString(operation.operationId) ? operation.operationId : action;
  const bindingNames = [...recordKeys(channel.bindings), ...recordKeys(operation.bindings)].sort();
  const messageInput =
    operation.message ??
    operation.messages ??
    (isRecord(channel.messages) ? Object.values(channel.messages) : undefined);
  const messageRefs = extractMessageRefs(messageInput);
  const messageFacts = extractMessageFacts(messageInput, document);
  const replyFacts = extractReplyFacts(operation.reply, document);
  const channelBindingConfiguration = safeBindingConfiguration(channel.bindings);
  const operationBindingConfiguration = safeBindingConfiguration(operation.bindings);
  const config: Record<string, MessagingJsonValue> = {
    namespace,
    channel: channelKey,
    channelKey,
    ...(address ? { address } : {}),
    action,
    operationKey,
    operationId,
    ...(bindingNames.length > 0 ? { bindingNames: [...new Set(bindingNames)] } : {}),
    ...(messageRefs.length > 0 ? { messageRefs } : {}),
    ...(messageFacts.correlationLocations.length > 0
      ? { correlationLocations: messageFacts.correlationLocations }
      : {}),
    ...(messageFacts.discriminatorProperties.length > 0
      ? { discriminatorProperties: messageFacts.discriminatorProperties }
      : {}),
    ...(messageFacts.messageIds.length > 0 ? { messageIds: messageFacts.messageIds } : {}),
    ...(messageFacts.contentTypes.length > 0 ? { contentTypes: messageFacts.contentTypes } : {}),
    ...(replyFacts.channelKey ? { replyChannel: replyFacts.channelKey } : {}),
    ...(replyFacts.address ? { replyAddress: replyFacts.address } : {}),
    ...(replyFacts.addressLocation ? { replyAddressLocation: replyFacts.addressLocation } : {}),
    ...(replyFacts.messageRefs.length > 0 ? { replyMessageRefs: replyFacts.messageRefs } : {}),
    ...(Object.keys(channelBindingConfiguration).length > 0 ? { channelBindingConfiguration } : {}),
    ...(Object.keys(operationBindingConfiguration).length > 0
      ? { operationBindingConfiguration }
      : {}),
  };
  return {
    id: "",
    kind: "message_operation",
    coordinate: `asyncapi:${namespace}:operation:${operationKey}`,
    name: operationId,
    binding: { kind: bindingKind(bindingNames), config },
    evidence: [
      { origin, pointer },
      ...messageFacts.pointers.map((messagePointer) => ({ origin, pointer: messagePointer })),
      ...replyFacts.pointers.map((replyPointer) => ({ origin, pointer: replyPointer })),
    ],
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
  return [
    ...new Set(
      values.flatMap((message) => {
        if (!isRecord(message)) return [];
        if (boundedString(message.$ref, 2048)) return [message.$ref];
        if (boundedString(message.name, 512)) return [message.name];
        return [];
      }),
    ),
  ].sort();
}

interface MessageFacts {
  correlationLocations: string[];
  discriminatorProperties: string[];
  messageIds: string[];
  contentTypes: string[];
  pointers: string[];
}

function extractMessageFacts(value: unknown, document: Record<string, unknown>): MessageFacts {
  const facts: MessageFacts = {
    correlationLocations: [],
    discriminatorProperties: [],
    messageIds: [],
    contentTypes: [],
    pointers: [],
  };
  for (const candidate of messageCandidates(value)) {
    const ref =
      isRecord(candidate) && boundedString(candidate.$ref, 2048) ? candidate.$ref : undefined;
    const resolved = ref ? resolveLocalReference(document, ref) : undefined;
    const message = resolved?.value ?? candidate;
    if (!isRecord(message)) continue;
    if (resolved) facts.pointers.push(resolved.pointer);
    const resolvedCorrelation = resolveMaybeReference(document, message.correlationId);
    const correlationId = isRecord(resolvedCorrelation) ? resolvedCorrelation : {};
    if (boundedString(correlationId.location, 2048)) {
      facts.correlationLocations.push(correlationId.location);
    }
    if (boundedString(message.messageId, 512)) facts.messageIds.push(message.messageId);
    if (boundedString(message.contentType, 255)) facts.contentTypes.push(message.contentType);
    const payload = resolveMaybeReference(document, message.payload);
    if (!isRecord(payload)) continue;
    const discriminator = isRecord(payload.discriminator) ? payload.discriminator : {};
    if (boundedString(discriminator.propertyName, 512)) {
      facts.discriminatorProperties.push(discriminator.propertyName);
    }
  }
  return {
    correlationLocations: uniqueSorted(facts.correlationLocations),
    discriminatorProperties: uniqueSorted(facts.discriminatorProperties),
    messageIds: uniqueSorted(facts.messageIds),
    contentTypes: uniqueSorted(facts.contentTypes),
    pointers: uniqueSorted(facts.pointers),
  };
}

function extractReplyFacts(
  value: unknown,
  document: Record<string, unknown>,
): {
  channelKey?: string;
  address?: string;
  addressLocation?: string;
  messageRefs: string[];
  pointers: string[];
} {
  if (!isRecord(value)) return { messageRefs: [], pointers: [] };
  const channelRef = isRecord(value.channel) ? value.channel.$ref : undefined;
  const channelKey = localReferenceName(channelRef);
  const resolvedChannel = boundedString(channelRef, 2048)
    ? resolveLocalReference(document, channelRef)
    : undefined;
  const channel = isRecord(resolvedChannel?.value) ? resolvedChannel.value : {};
  const address = boundedString(channel.address) ? channel.address : undefined;
  const replyAddress = isRecord(value.address) ? value.address : {};
  const addressLocation = boundedString(replyAddress.location, 2048)
    ? replyAddress.location
    : undefined;
  const messageInput =
    value.message ??
    value.messages ??
    (isRecord(channel.messages) ? Object.values(channel.messages) : undefined);
  const messageRefs = extractMessageRefs(messageInput);
  const pointers = [resolvedChannel?.pointer]
    .filter((item): item is string => Boolean(item))
    .concat(
      messageRefs
        .map((ref) => resolveLocalReference(document, ref)?.pointer)
        .filter((item): item is string => Boolean(item)),
    );
  return {
    channelKey,
    address,
    addressLocation,
    messageRefs,
    pointers: uniqueSorted(pointers),
  };
}

function messageCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.slice(0, 256);
  if (isRecord(value) && Array.isArray(value.oneOf)) return value.oneOf.slice(0, 256);
  return value === undefined ? [] : [value];
}

function resolveMaybeReference(document: Record<string, unknown>, value: unknown): unknown {
  if (!isRecord(value) || !boundedString(value.$ref, 2048)) return value;
  return resolveLocalReference(document, value.$ref)?.value;
}

function resolveLocalReference(
  document: Record<string, unknown>,
  reference: string,
): { value: unknown; pointer: string } | undefined {
  if (!reference.startsWith("#/")) return undefined;
  const segments = reference
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = document;
  for (const segment of segments) {
    if (!isRecord(current) || !(segment in current)) return undefined;
    current = current[segment];
  }
  return { value: current, pointer: reference.slice(1) };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
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
