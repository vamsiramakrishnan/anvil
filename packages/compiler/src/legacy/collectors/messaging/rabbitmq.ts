import type { MessagingJsonValue, MessagingObservation } from "./model.js";
import { boundedString, isRecord } from "./safety.js";

export function parseRabbitMqDefinitions(value: unknown, origin: string): MessagingObservation[] {
  if (!isRecord(value)) return [];
  return [
    ...destinations(value.queues, "queue", origin),
    ...destinations(value.exchanges, "exchange", origin),
    ...routes(value.bindings, origin),
  ];
}

export function hasRabbitMqNonTopologySections(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const ignored = new Set([
    "global_parameters",
    "parameters",
    "permissions",
    "policies",
    "topic_permissions",
    "users",
    "vhosts",
  ]);
  return Object.keys(value).some((key) => ignored.has(key));
}

function destinations(
  value: unknown,
  kind: "queue" | "exchange",
  origin: string,
): MessagingObservation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (!isRecord(entry) || typeof entry.name !== "string") return [];
    const vhost = boundedString(entry.vhost) ? entry.vhost : "/";
    const displayName = entry.name || "(default exchange)";
    const config: Record<string, MessagingJsonValue> = {
      destinationKind: kind,
      vhost,
      name: entry.name,
    };
    for (const field of ["durable", "auto_delete", "internal"] as const) {
      if (typeof entry[field] === "boolean") config[field] = entry[field];
    }
    if (kind === "exchange" && boundedString(entry.type)) config.exchangeType = entry.type;
    const args = safeArguments(entry.arguments);
    if (Object.keys(args).length > 0) config.arguments = args;
    return [
      {
        id: "",
        kind: "destination" as const,
        coordinate: `rabbitmq:vhost:${vhost}:${kind}:${entry.name || "<default>"}`,
        name: displayName,
        binding: { kind: "rabbitmq" as const, config },
        evidence: [{ origin, pointer: `/${kind === "queue" ? "queues" : "exchanges"}/${index}` }],
        confidence: "declared" as const,
      },
    ];
  });
}

function routes(value: unknown, origin: string): MessagingObservation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.source !== "string" ||
      !boundedString(entry.destination) ||
      !boundedString(entry.destination_type)
    ) {
      return [];
    }
    const vhost = boundedString(entry.vhost) ? entry.vhost : "/";
    const routingKey = typeof entry.routing_key === "string" ? entry.routing_key : "";
    const config: Record<string, MessagingJsonValue> = {
      vhost,
      source: entry.source,
      destination: entry.destination,
      destinationKind: entry.destination_type,
      routingKey,
    };
    const args = safeArguments(entry.arguments);
    if (Object.keys(args).length > 0) config.arguments = args;
    return [
      {
        id: "",
        kind: "routing_binding" as const,
        coordinate:
          `rabbitmq:vhost:${vhost}:binding:${entry.source}->${entry.destination_type}:` +
          `${entry.destination}:${routingKey}`,
        name: `${entry.source || "(default)"} → ${entry.destination}`,
        binding: { kind: "rabbitmq" as const, config },
        evidence: [{ origin, pointer: `/bindings/${index}` }],
        confidence: "declared" as const,
      },
    ];
  });
}

function safeArguments(value: unknown): Record<string, MessagingJsonValue> {
  if (!isRecord(value)) return {};
  const allowed = new Set([
    "x-dead-letter-exchange",
    "x-dead-letter-routing-key",
    "x-message-ttl",
    "x-max-length",
    "x-queue-type",
    "x-single-active-consumer",
  ]);
  const out: Record<string, MessagingJsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (allowed.has(key) && ["string", "number", "boolean"].includes(typeof child)) {
      out[key] = child as string | number | boolean;
    }
  }
  return out;
}
