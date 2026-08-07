import { XMLValidator } from "fast-xml-parser";
import { childrenNamed, findAll, parseXml, type XmlElement } from "../../../protocols/xml.js";
import type { MessagingDiagnostic, MessagingJsonValue, MessagingObservation } from "./model.js";

export function parseArtemisXml(
  text: string,
  origin: string,
): { observations: MessagingObservation[]; diagnostics: MessagingDiagnostic[] } {
  if (XMLValidator.validate(text) !== true) {
    return {
      observations: [],
      diagnostics: [
        {
          level: "error",
          code: "messaging/malformed_artemis_xml",
          message: `Could not parse malformed Artemis broker XML '${origin}'.`,
          coordinate: { origin },
        },
      ],
    };
  }
  let root: XmlElement;
  try {
    root = parseXml(text);
  } catch {
    return {
      observations: [],
      diagnostics: [
        {
          level: "error",
          code: "messaging/malformed_artemis_xml",
          message: `Could not parse malformed Artemis broker XML '${origin}'.`,
          coordinate: { origin },
        },
      ],
    };
  }
  const observations: MessagingObservation[] = [];
  const nestedQueueNames = new Set<string>();
  findAll(root, "address").forEach((address, addressIndex) => {
    const name = address.attrs.name?.trim();
    if (!name) return;
    const routingTypes = address.children
      .map((child) => child.tag.replace(/^.*:/, ""))
      .filter((tag) => tag === "anycast" || tag === "multicast")
      .sort();
    observations.push({
      id: "",
      kind: "destination",
      coordinate: `artemis:address:${name}`,
      name,
      binding: {
        kind: "artemis",
        config: { destinationKind: "address", ...(routingTypes.length ? { routingTypes } : {}) },
      },
      evidence: [{ origin, pointer: `/addresses/address[${addressIndex}]` }],
      confidence: "declared",
    });
    for (const routing of address.children) {
      for (const queue of childrenNamed(routing, "queue")) {
        const queueName = queue.attrs.name?.trim();
        if (!queueName) continue;
        nestedQueueNames.add(queueName);
        observations.push(queueObservation(queue, queueName, name, origin, addressIndex));
      }
    }
  });
  findAll(root, "queue").forEach((queue, index) => {
    const name = queue.attrs.name?.trim();
    if (!name || nestedQueueNames.has(name)) return;
    observations.push(queueObservation(queue, name, queue.attrs.address, origin, index));
  });
  const diagnostics: MessagingDiagnostic[] = [];
  if (observations.length === 0) {
    diagnostics.push({
      level: "warning",
      code: "messaging/artemis_no_destinations",
      message: `Artemis broker XML '${origin}' declares no supported address or queue.`,
      coordinate: { origin },
    });
  }
  return { observations, diagnostics };
}

function queueObservation(
  queue: XmlElement,
  name: string,
  address: string | undefined,
  origin: string,
  index: number,
): MessagingObservation {
  const config: Record<string, MessagingJsonValue> = { destinationKind: "queue" };
  if (address) config.address = address;
  for (const attr of [
    "durable",
    "routing-type",
    "max-consumers",
    "purge-on-no-consumers",
  ] as const) {
    if (queue.attrs[attr] !== undefined) config[attr] = queue.attrs[attr];
  }
  const filter = childrenNamed(queue, "filter")[0];
  if (filter?.attrs.string) config.filter = filter.attrs.string;
  return {
    id: "",
    kind: "destination",
    coordinate: `artemis:queue:${name}`,
    name,
    binding: { kind: "artemis", config },
    evidence: [{ origin, pointer: `/queues/queue[${index}]` }],
    confidence: "declared",
  };
}
