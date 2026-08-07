import type { MessagingDiagnostic, MessagingJsonValue, MessagingObservation } from "./model.js";
import { boundedString, isRecord } from "./safety.js";

const QUEUE_TYPES = new Set(["QLOCAL", "QREMOTE", "QALIAS", "QMODEL"]);
const SAFE_QUEUE_ATTRIBUTES = new Set([
  "BOQNAME",
  "BOTHRESH",
  "DEFPSIST",
  "DEFSOPT",
  "DESCR",
  "MAXDEPTH",
  "RNAME",
  "RQMNAME",
  "TARGQ",
  "TARGTYPE",
  "XMITQ",
]);
const SAFE_CHANNEL_ATTRIBUTES = new Set([
  "CHLTYPE",
  "CONNAME",
  "DESCR",
  "QMNAME",
  "SSLCAUTH",
  "SSLCIPH",
  "TRPTYPE",
]);

export function parseMqsc(
  text: string,
  origin: string,
): { observations: MessagingObservation[]; diagnostics: MessagingDiagnostic[] } {
  const observations: MessagingObservation[] = [];
  const diagnostics: MessagingDiagnostic[] = [];
  for (const statement of mqscStatements(text)) {
    const parsed = parseCommand(statement.text);
    if (!parsed) continue;
    const { type, name, attributes } = parsed;
    if (!QUEUE_TYPES.has(type) && type !== "TOPIC" && type !== "CHANNEL") continue;
    const config: Record<string, MessagingJsonValue> = {
      queueManager: "unspecified",
      objectType: type,
      ...pickAttributes(
        attributes,
        type === "CHANNEL" ? SAFE_CHANNEL_ATTRIBUTES : SAFE_QUEUE_ATTRIBUTES,
      ),
    };
    const objectKind = QUEUE_TYPES.has(type) ? "queue" : type.toLowerCase();
    observations.push({
      id: "",
      kind: "destination",
      coordinate: `ibm_mq:queue-manager:unspecified:${objectKind}:${name}`,
      name,
      binding: { kind: "ibm_mq", config },
      evidence: [
        {
          origin,
          pointer: `/mqsc/${type}/${name}`,
          span: { start: statement.startLine, end: statement.endLine },
        },
      ],
      confidence: "declared",
    });
  }
  if (observations.length > 0) {
    diagnostics.push({
      level: "warning",
      code: "messaging/mqsc_missing_queue_manager_coordinate",
      message:
        `MQSC '${origin}' contains no portable queue-manager identity; observations remain ` +
        "explicitly scoped to 'unspecified'. Supply a manifest coordinate before adoption.",
      coordinate: { origin },
    });
  } else {
    diagnostics.push({
      level: "warning",
      code: "messaging/mqsc_no_supported_objects",
      message: `MQSC '${origin}' contains no supported DEFINE/ALTER queue, topic, or channel.`,
      coordinate: { origin },
    });
  }
  return { observations, diagnostics };
}

export function parseCcdt(
  value: unknown,
  origin: string,
): { observations: MessagingObservation[]; diagnostics: MessagingDiagnostic[] } {
  if (!isRecord(value)) return { observations: [], diagnostics: [] };
  const rawChannels = Array.isArray(value.channels)
    ? value.channels
    : Array.isArray(value.channel)
      ? value.channel
      : [];
  const observations: MessagingObservation[] = [];
  const diagnostics: MessagingDiagnostic[] = [];
  rawChannels.forEach((channel, index) => {
    if (!isRecord(channel)) return;
    const client = isRecord(channel.clientConnection) ? channel.clientConnection : {};
    const name = firstString(channel.name, channel.channelName, client.channelName);
    if (!name) return;
    const queueManager = firstString(
      channel.queueManager,
      channel.qmgrName,
      client.queueManager,
      client.queueManagerName,
    );
    const config: Record<string, MessagingJsonValue> = {
      channel: name,
      queueManager: queueManager ?? "unspecified",
    };
    copyString(channel, config, "connectionName");
    copyString(channel, config, "transportType");
    copyString(channel, config, "sslCipherSpec");
    copyString(client, config, "connectionName");
    copyString(client, config, "transportType");
    const connections = safeConnections(client.connection);
    if (connections.length > 0) config.connections = connections;
    observations.push({
      id: "",
      kind: "destination",
      coordinate: `ibm_mq:queue-manager:${queueManager ?? "unspecified"}:channel:${name}`,
      name,
      binding: { kind: "ibm_mq", config },
      evidence: [{ origin, pointer: `/channels/${index}` }],
      confidence: "declared",
    });
    if (!queueManager) {
      diagnostics.push({
        level: "warning",
        code: "messaging/ccdt_missing_queue_manager_coordinate",
        message: `CCDT channel '${name}' has no explicit queue-manager coordinate.`,
        coordinate: { origin, pointer: `/channels/${index}` },
      });
    }
  });
  return { observations, diagnostics };
}

interface MqscStatement {
  text: string;
  startLine: number;
  endLine: number;
}

function mqscStatements(text: string): MqscStatement[] {
  const statements: MqscStatement[] = [];
  let current = "";
  let startLine = 0;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("*")) return;
    if (!current) startLine = index + 1;
    const continued = /[+-]\s*$/.test(trimmed);
    current += `${current ? " " : ""}${trimmed.replace(/[+-]\s*$/, "")}`;
    if (!continued) {
      statements.push({ text: current, startLine, endLine: index + 1 });
      current = "";
    }
  });
  if (current) statements.push({ text: current, startLine, endLine: lines.length });
  return statements;
}

function parseCommand(
  statement: string,
): { type: string; name: string; attributes: Map<string, string> } | undefined {
  const match = /^(?:DEFINE|ALTER)\s+([A-Z0-9_]+)\s*\(\s*(['"]?)(.*?)\2\s*\)\s*(.*)$/i.exec(
    statement,
  );
  if (!match) return undefined;
  const type = match[1]?.toUpperCase();
  const name = match[3]?.trim();
  if (!type || !name || name.length > 256) return undefined;
  const attributes = new Map<string, string>();
  const tail = match[4] ?? "";
  for (const attr of tail.matchAll(/([A-Z][A-Z0-9_]*)\s*\(\s*('[^']*'|"[^"]*"|[^)]*)\)/gi)) {
    const key = attr[1]?.toUpperCase();
    const rawValue = attr[2]?.trim();
    if (!key || rawValue === undefined) continue;
    attributes.set(key, rawValue.replace(/^(['"])(.*)\1$/, "$2"));
  }
  return { type, name, attributes };
}

function pickAttributes(
  attributes: ReadonlyMap<string, string>,
  allowed: ReadonlySet<string>,
): Record<string, MessagingJsonValue> {
  const out: Record<string, MessagingJsonValue> = {};
  for (const [key, value] of [...attributes].sort(([a], [b]) => a.localeCompare(b))) {
    if (allowed.has(key) && value.length <= 4096) out[key.toLowerCase()] = value;
  }
  return out;
}

function safeConnections(value: unknown): MessagingJsonValue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((connection) => {
    if (!isRecord(connection) || !boundedString(connection.host)) return [];
    const safe: Record<string, MessagingJsonValue> = { host: connection.host };
    if (
      typeof connection.port === "number" &&
      Number.isInteger(connection.port) &&
      connection.port > 0 &&
      connection.port <= 65_535
    ) {
      safe.port = connection.port;
    }
    return [safe];
  });
}

function copyString(
  source: Record<string, unknown>,
  target: Record<string, MessagingJsonValue>,
  key: string,
): void {
  if (boundedString(source[key])) target[key] = source[key];
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => boundedString(value));
}
