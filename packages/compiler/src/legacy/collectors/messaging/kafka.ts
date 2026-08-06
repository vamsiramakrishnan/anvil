import { createHash } from "node:crypto";
import type { MessagingJsonValue, MessagingObservation } from "./model.js";
import { boundedString, isRecord } from "./safety.js";

export function parseKafkaManifest(value: unknown, origin: string): MessagingObservation[] {
  if (!isRecord(value)) return [];
  const cluster = boundedString(value.clusterId)
    ? value.clusterId
    : boundedString(value.cluster)
      ? value.cluster
      : "unspecified";
  return [
    ...parseTopics(value.topics, origin, cluster),
    ...parseSubjects(
      isRecord(value.schemaRegistry) ? value.schemaRegistry.subjects : value.subjects,
      origin,
      cluster,
    ),
  ];
}

function parseTopics(value: unknown, origin: string, cluster: string): MessagingObservation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((topic, index) => {
    if (!isRecord(topic) || !boundedString(topic.name)) return [];
    const config: Record<string, MessagingJsonValue> = { cluster, topic: topic.name };
    copyInteger(topic, config, "partitions");
    copyInteger(topic, config, "replicationFactor");
    copyInteger(topic, config, "retentionMs");
    if (boundedString(topic.cleanupPolicy)) config.cleanupPolicy = topic.cleanupPolicy;
    if (Array.isArray(topic.cleanupPolicy)) {
      config.cleanupPolicy = topic.cleanupPolicy.filter((item): item is string =>
        boundedString(item),
      );
    }
    const configs = safeKafkaConfigs(topic.configs);
    if (Object.keys(configs).length > 0) config.configs = configs;
    const schemaSubjects = Array.isArray(topic.schemaSubjects)
      ? topic.schemaSubjects.filter((item): item is string => boundedString(item)).sort()
      : [];
    if (schemaSubjects.length > 0) config.schemaSubjects = schemaSubjects;
    return [
      {
        id: "",
        kind: "destination" as const,
        coordinate: `kafka:cluster:${cluster}:topic:${topic.name}`,
        name: topic.name,
        binding: { kind: "kafka" as const, config },
        evidence: [{ origin, pointer: `/topics/${index}` }],
        confidence: "declared" as const,
      },
    ];
  });
}

function parseSubjects(value: unknown, origin: string, cluster: string): MessagingObservation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((subject, index) => {
    if (!isRecord(subject) || !boundedString(subject.subject)) return [];
    const config: Record<string, MessagingJsonValue> = { cluster, subject: subject.subject };
    if (boundedString(subject.format)) config.format = subject.format;
    if (boundedString(subject.compatibility)) config.compatibility = subject.compatibility;
    if (typeof subject.schema === "string") {
      config.schemaDigest = `sha256:${createHash("sha256").update(subject.schema).digest("hex")}`;
    }
    return [
      {
        id: "",
        kind: "schema_subject" as const,
        coordinate: `kafka:cluster:${cluster}:schema-subject:${subject.subject}`,
        name: subject.subject,
        binding: { kind: "kafka" as const, config },
        evidence: [{ origin, pointer: `/schemaRegistry/subjects/${index}` }],
        confidence: "declared" as const,
      },
    ];
  });
}

function safeKafkaConfigs(value: unknown): Record<string, MessagingJsonValue> {
  if (!isRecord(value)) return {};
  const allowed = new Set([
    "retention.ms",
    "cleanup.policy",
    "min.insync.replicas",
    "max.message.bytes",
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
  key: string,
): void {
  const value = source[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) target[key] = value;
}
