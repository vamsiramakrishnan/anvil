import { createHash } from "node:crypto";
import type { MessagingDiagnostic, MessagingJsonValue, MessagingObservation } from "./model.js";
import { boundedString, isRecord } from "./safety.js";

const MAX_PROJECTED_RECORDS = 10_000;

export function detectKafkaDocument(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(isKafkaRecord);
  if (!isRecord(value)) return false;
  if (isStrimziResource(value)) return true;
  if (Array.isArray(value.items) && value.items.some(isStrimziResource)) return true;
  if (Array.isArray(value.topics) || isRecord(value.schemaRegistry)) return true;
  if (Array.isArray(value.subjects) || Array.isArray(value.schemas)) return true;
  if (boundedString(value.subject) && ("schema" in value || "schemaType" in value)) return true;
  return isConfluentTopicCollection(value) || isKafkaRecord(value);
}

export function parseKafkaManifest(
  value: unknown,
  origin: string,
): { observations: MessagingObservation[]; diagnostics: MessagingDiagnostic[] } {
  const observations: MessagingObservation[] = [];
  const diagnostics: MessagingDiagnostic[] = [];
  let projected = 0;
  const append = (items: MessagingObservation[]): void => {
    const available = Math.max(0, MAX_PROJECTED_RECORDS - projected);
    observations.push(...items.slice(0, available));
    projected += items.length;
  };

  if (Array.isArray(value)) {
    append(parseKafkaRecords(value, origin, "unspecified", ""));
  } else if (isRecord(value)) {
    const cluster = clusterName(value);
    if (isStrimziResource(value)) append(parseStrimziResource(value, origin, ""));
    if (Array.isArray(value.items)) {
      for (const [index, item] of value.items.entries()) {
        if (isRecord(item) && isStrimziResource(item)) {
          append(parseStrimziResource(item, origin, `/items/${index}`));
        }
      }
    }
    append(parseTopics(value.topics, origin, cluster, "/topics"));
    if (isConfluentTopicCollection(value)) {
      append(parseTopics(value.data, origin, cluster, "/data"));
    } else if (isKafkaRecord(value) && !isStrimziResource(value)) {
      append(parseTopics([value], origin, cluster, ""));
    }
    const schemaRegistry = isRecord(value.schemaRegistry) ? value.schemaRegistry : undefined;
    append(
      parseSubjects(
        schemaRegistry?.subjects ?? value.subjects ?? value.schemas,
        origin,
        cluster,
        schemaRegistry ? "/schemaRegistry/subjects" : value.schemas ? "/schemas" : "/subjects",
      ),
    );
    if (boundedString(value.subject) && ("schema" in value || "schemaType" in value)) {
      append(parseSubjects([value], origin, cluster, ""));
    }
  }

  if (projected > MAX_PROJECTED_RECORDS) {
    diagnostics.push({
      level: "warning",
      code: "messaging/kafka_projection_truncated",
      message: `Kafka artifact '${origin}' exceeded the ${MAX_PROJECTED_RECORDS}-record projection limit.`,
      coordinate: { origin },
    });
  }
  if (observations.length === 0) {
    diagnostics.push({
      level: "warning",
      code: "messaging/kafka_no_supported_objects",
      message: `Kafka artifact '${origin}' declares no supported topics, connectors, or schema subjects.`,
      coordinate: { origin },
    });
  }
  return { observations, diagnostics };
}

function parseTopics(
  value: unknown,
  origin: string,
  cluster: string,
  basePointer: string,
): MessagingObservation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((topic, index) => {
    if (!isRecord(topic)) return [];
    const name = topicName(topic);
    if (!name) return [];
    const effectiveCluster = clusterName(topic, cluster);
    const config: Record<string, MessagingJsonValue> = { cluster: effectiveCluster, topic: name };
    copyIntegerAlias(topic, config, "partitions", ["partitions", "partitions_count"]);
    if (Array.isArray(topic.partitions)) config.partitions = topic.partitions.length;
    copyIntegerAlias(topic, config, "replicationFactor", [
      "replicationFactor",
      "replication_factor",
      "replicas",
    ]);
    copyInteger(topic, config, "retentionMs");
    if (boundedString(topic.cleanupPolicy)) config.cleanupPolicy = topic.cleanupPolicy;
    if (Array.isArray(topic.cleanupPolicy)) {
      config.cleanupPolicy = topic.cleanupPolicy.filter((item): item is string =>
        boundedString(item),
      );
    }
    const configs = safeKafkaConfigs(topic.configs ?? topic.config);
    if (Object.keys(configs).length > 0) config.configs = configs;
    const schemaSubjects = Array.isArray(topic.schemaSubjects)
      ? topic.schemaSubjects.filter((item): item is string => boundedString(item)).sort()
      : [];
    if (schemaSubjects.length > 0) config.schemaSubjects = schemaSubjects;
    return [
      {
        id: "",
        kind: "destination" as const,
        coordinate: `kafka:cluster:${effectiveCluster}:topic:${name}`,
        name,
        binding: { kind: "kafka" as const, config },
        evidence: [{ origin, pointer: `${basePointer}/${index}` || "/" }],
        confidence: "declared" as const,
      },
    ];
  });
}

function parseSubjects(
  value: unknown,
  origin: string,
  cluster: string,
  basePointer: string,
): MessagingObservation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((subject, index) => {
    const name = boundedString(subject) ? subject : isRecord(subject) ? subject.subject : undefined;
    if (!boundedString(name)) return [];
    const record = isRecord(subject) ? subject : {};
    const config: Record<string, MessagingJsonValue> = { cluster, subject: name };
    const format = boundedString(record.format)
      ? record.format
      : boundedString(record.schemaType)
        ? record.schemaType.toLowerCase()
        : undefined;
    if (format) config.format = format;
    const compatibility = boundedString(record.compatibility)
      ? record.compatibility
      : boundedString(record.compatibilityLevel)
        ? record.compatibilityLevel
        : undefined;
    if (compatibility) config.compatibility = compatibility;
    copyInteger(record, config, "id", "schemaId");
    copyInteger(record, config, "version");
    if (typeof record.schema === "string" || isRecord(record.schema)) {
      const serialized =
        typeof record.schema === "string" ? record.schema : canonicalJson(record.schema);
      config.schemaDigest = `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
    }
    const references = safeSchemaReferences(record.references);
    if (references.length > 0) config.references = references;
    return [
      {
        id: "",
        kind: "schema_subject" as const,
        coordinate: `kafka:cluster:${cluster}:schema-subject:${name}`,
        name,
        binding: { kind: "kafka" as const, config },
        evidence: [{ origin, pointer: `${basePointer}/${index}` || "/" }],
        confidence: "declared" as const,
      },
    ];
  });
}

function parseKafkaRecords(
  value: unknown[],
  origin: string,
  cluster: string,
  basePointer: string,
): MessagingObservation[] {
  const topics = value.filter((item) => isRecord(item) && topicName(item));
  const subjects = value.filter(
    (item) =>
      isRecord(item) && boundedString(item.subject) && ("schema" in item || "schemaType" in item),
  );
  return [
    ...parseTopics(topics, origin, cluster, basePointer),
    ...parseSubjects(subjects, origin, cluster, basePointer),
  ];
}

function parseStrimziResource(
  resource: Record<string, unknown>,
  origin: string,
  pointer: string,
): MessagingObservation[] {
  const kind = resource.kind;
  const metadata = isRecord(resource.metadata) ? resource.metadata : {};
  const spec = isRecord(resource.spec) ? resource.spec : {};
  const name = boundedString(metadata.name) ? metadata.name : undefined;
  if (!name) return [];
  const cluster = strimziCluster(metadata) ?? "unspecified";
  if (kind === "KafkaTopic") {
    const topic = boundedString(spec.topicName) ? spec.topicName : name;
    const config: Record<string, MessagingJsonValue> = { cluster, topic };
    copyInteger(spec, config, "partitions");
    copyInteger(spec, config, "replicas", "replicationFactor");
    const configs = safeKafkaConfigs(spec.config);
    if (Object.keys(configs).length > 0) config.configs = configs;
    return [
      {
        id: "",
        kind: "destination",
        coordinate: `kafka:cluster:${cluster}:topic:${topic}`,
        name: topic,
        binding: { kind: "kafka", config },
        evidence: [{ origin, pointer: `${pointer}/spec` || "/spec" }],
        confidence: "declared",
      },
    ];
  }
  if (kind !== "KafkaConnector" || !boundedString(spec.class)) return [];
  const connectorClass = spec.class;
  const connectorConfig = isRecord(spec.config) ? spec.config : {};
  const topics = connectorTopics(connectorConfig.topics ?? connectorConfig.topic);
  const config: Record<string, MessagingJsonValue> = {
    cluster,
    connector: name,
    connectorClass,
    action: connectorAction(connectorClass),
  };
  copyInteger(spec, config, "tasksMax");
  if (topics.length > 0) {
    config.topics = topics;
    if (topics.length === 1) config.topic = topics[0] as string;
  }
  if (boundedString(connectorConfig["topics.regex"])) {
    config.topicPattern = connectorConfig["topics.regex"];
  }
  if (boundedString(connectorConfig["errors.deadletterqueue.topic.name"])) {
    config.deadLetterQueue = connectorConfig["errors.deadletterqueue.topic.name"];
  }
  const safeConfig = safeConnectorConfig(connectorConfig);
  if (Object.keys(safeConfig).length > 0) config.configs = safeConfig;
  return [
    {
      id: "",
      kind: "message_operation",
      coordinate: `kafka-connect:cluster:${cluster}:connector:${name}`,
      name,
      binding: { kind: "kafka", config },
      evidence: [{ origin, pointer: `${pointer}/spec` || "/spec" }],
      confidence: "declared",
    },
  ];
}

function safeKafkaConfigs(value: unknown): Record<string, MessagingJsonValue> {
  if (!isRecord(value)) return {};
  const allowed = new Set([
    "retention.ms",
    "cleanup.policy",
    "min.insync.replicas",
    "max.message.bytes",
    "compression.type",
    "delete.retention.ms",
    "max.compaction.lag.ms",
    "message.timestamp.type",
    "min.compaction.lag.ms",
    "segment.bytes",
    "segment.ms",
  ]);
  const out: Record<string, MessagingJsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (allowed.has(key) && ["string", "number", "boolean"].includes(typeof child)) {
      out[key] = child as string | number | boolean;
    }
  }
  return out;
}

function copyInteger(
  source: Record<string, unknown>,
  target: Record<string, MessagingJsonValue>,
  sourceKey: string,
  targetKey = sourceKey,
): void {
  const value = source[sourceKey];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) target[targetKey] = value;
}

function copyIntegerAlias(
  source: Record<string, unknown>,
  target: Record<string, MessagingJsonValue>,
  targetKey: string,
  sourceKeys: string[],
): void {
  for (const sourceKey of sourceKeys) {
    const value = source[sourceKey];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      target[targetKey] = value;
      return;
    }
  }
}

function isStrimziResource(value: unknown): boolean {
  return (
    isRecord(value) &&
    boundedString(value.apiVersion) &&
    value.apiVersion.startsWith("kafka.strimzi.io/") &&
    ["KafkaTopic", "KafkaConnector"].includes(String(value.kind))
  );
}

function isConfluentTopicCollection(value: Record<string, unknown>): boolean {
  return value.kind === "KafkaTopicList" && Array.isArray(value.data);
}

function isKafkaRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (isStrimziResource(value)) return true;
  if (boundedString(value.topic_name) && boundedString(value.cluster_id)) return true;
  if (boundedString(value.topicName) && ("partitions" in value || "configs" in value)) return true;
  return boundedString(value.subject) && ("schema" in value || "schemaType" in value);
}

function clusterName(value: Record<string, unknown>, fallback = "unspecified"): string {
  if (boundedString(value.clusterId)) return value.clusterId;
  if (boundedString(value.cluster_id)) return value.cluster_id;
  if (boundedString(value.cluster)) return value.cluster;
  return fallback;
}

function topicName(value: Record<string, unknown>): string | undefined {
  if (boundedString(value.name)) return value.name;
  if (boundedString(value.topicName)) return value.topicName;
  if (boundedString(value.topic_name)) return value.topic_name;
  if (boundedString(value.topic)) return value.topic;
  return undefined;
}

function strimziCluster(metadata: Record<string, unknown>): string | undefined {
  const labels = isRecord(metadata.labels) ? metadata.labels : {};
  return boundedString(labels["strimzi.io/cluster"]) ? labels["strimzi.io/cluster"] : undefined;
}

function connectorAction(connectorClass: string): string {
  if (/SourceConnector$/u.test(connectorClass)) return "publish";
  if (/SinkConnector$/u.test(connectorClass)) return "subscribe";
  return "unknown";
}

function connectorTopics(value: unknown): string[] {
  const values = Array.isArray(value) ? value : boundedString(value) ? value.split(",") : [];
  return [
    ...new Set(
      values
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => boundedString(item, 512)),
    ),
  ].sort();
}

function safeConnectorConfig(value: Record<string, unknown>): Record<string, MessagingJsonValue> {
  const allowed = new Set([
    "errors.deadletterqueue.context.headers.enable",
    "errors.deadletterqueue.topic.name",
    "errors.log.enable",
    "errors.tolerance",
    "key.converter",
    "topic.creation.default.partitions",
    "topic.creation.default.replication.factor",
    "topics.regex",
    "value.converter",
  ]);
  const out: Record<string, MessagingJsonValue> = {};
  for (const [key, child] of Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (allowed.has(key) && ["string", "number", "boolean"].includes(typeof child)) {
      out[key] = child as string | number | boolean;
    }
  }
  return out;
}

function safeSchemaReferences(value: unknown): MessagingJsonValue[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 256).flatMap((reference) => {
    if (!isRecord(reference) || !boundedString(reference.subject)) return [];
    const projected: Record<string, MessagingJsonValue> = { subject: reference.subject };
    if (boundedString(reference.name)) projected.name = reference.name;
    if (
      typeof reference.version === "number" &&
      Number.isInteger(reference.version) &&
      reference.version >= 0
    ) {
      projected.version = reference.version;
    }
    return [projected];
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
