import { describe, expect, it } from "vitest";
import { collectMessagingLegacy } from "./collector.js";

const ASYNCAPI = `asyncapi: 2.6.0
info:
  title: Refund Events
  version: 1.0.0
channels:
  PAY.REFUND.REQUEST:
    bindings:
      jms:
        destination: PAY.REFUND.REQUEST
        destinationType: queue
    publish:
      operationId: submitRefund
      message:
        $ref: '#/components/messages/RefundCommand'
components:
  messages:
    RefundCommand:
      name: RefundCommand
      payload:
        type: object
`;

describe("messaging legacy collector", () => {
  it("extracts a bounded AsyncAPI channel and operation without inventing business semantics", () => {
    const result = collectMessagingLegacy([{ path: "contracts/asyncapi.yaml", bytes: ASYNCAPI }]);

    expect(result.observations).toHaveLength(2);
    expect(result.observations).toContainEqual(
      expect.objectContaining({
        kind: "destination",
        coordinate: "asyncapi:Refund Events:channel:PAY.REFUND.REQUEST",
        binding: expect.objectContaining({ kind: "jms" }),
        confidence: "declared",
      }),
    );
    expect(result.observations).toContainEqual(
      expect.objectContaining({
        kind: "message_operation",
        coordinate: "asyncapi:Refund Events:operation:submitRefund",
        binding: {
          kind: "jms",
          config: expect.objectContaining({
            action: "publish",
            messageRefs: ["#/components/messages/RefundCommand"],
          }),
        },
      }),
    );
  });

  it("collects Artemis and RabbitMQ declared topology", () => {
    const artemis = `<configuration><core><addresses>
      <address name="PAY.REFUND"><anycast>
        <queue name="PAY.REFUND.IN" durable="true"><filter string="type='refund'"/></queue>
      </anycast></address>
    </addresses></core></configuration>`;
    const rabbit = JSON.stringify({
      queues: [
        {
          name: "refund.in",
          vhost: "payments",
          durable: true,
          arguments: { "x-dead-letter-exchange": "refund.dlx", ignored: "not-projected" },
        },
      ],
      exchanges: [{ name: "refunds", vhost: "payments", type: "topic", durable: true }],
      bindings: [
        {
          vhost: "payments",
          source: "refunds",
          destination: "refund.in",
          destination_type: "queue",
          routing_key: "refund.requested",
        },
      ],
    });
    const result = collectMessagingLegacy([
      { path: "artemis/broker.xml", bytes: artemis },
      { path: "rabbit/definitions.json", bytes: rabbit },
    ]);

    expect(result.observations.map((item) => item.coordinate)).toEqual([
      "artemis:address:PAY.REFUND",
      "artemis:queue:PAY.REFUND.IN",
      "rabbitmq:vhost:payments:binding:refunds->queue:refund.in:refund.requested",
      "rabbitmq:vhost:payments:exchange:refunds",
      "rabbitmq:vhost:payments:queue:refund.in",
    ]);
    expect(JSON.stringify(result)).not.toContain("not-projected");
  });

  it("collects Kafka topic and schema coordinates while retaining only a schema digest", () => {
    const result = collectMessagingLegacy([
      {
        path: "kafka/manifest.json",
        bytes: JSON.stringify({
          clusterId: "payments-prod",
          topics: [
            {
              name: "refund.commands",
              partitions: 12,
              configs: { "retention.ms": "604800000", "unclean.leader.election.enable": true },
              schemaSubjects: ["refund.commands-value"],
            },
          ],
          schemaRegistry: {
            subjects: [
              {
                subject: "refund.commands-value",
                format: "avro",
                compatibility: "BACKWARD",
                schema: '{"type":"record","name":"Refund"}',
              },
            ],
          },
        }),
      },
    ]);

    expect(result.observations.map((item) => item.kind)).toEqual(["schema_subject", "destination"]);
    const subject = result.observations.find((item) => item.kind === "schema_subject");
    expect(subject?.binding.config.schemaDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain('"name":"Refund"');
    expect(JSON.stringify(result)).not.toContain("unclean.leader.election.enable");
  });

  it("collects IBM MQ MQSC and CCDT declarations without executing commands", () => {
    const mqsc = `* captured export
DEFINE QLOCAL('PAY.REFUND.IN') +
  DEFPSIST(YES) MAXDEPTH(5000) BOTHRESH(3) BOQNAME('PAY.REFUND.BOQ')
DEFINE CHANNEL('PAY.CLIENT') CHLTYPE(SVRCONN) TRPTYPE(TCP) SSLCIPH('TLS_AES_256_GCM_SHA384')`;
    const ccdt = JSON.stringify({
      channels: [
        {
          channelName: "PAY.CLIENT",
          qmgrName: "PAYQM1",
          connectionName: "mq.internal(1414)",
          transportType: "TCP",
        },
      ],
    });
    const result = collectMessagingLegacy([
      { path: "mq/PAYQM.mqsc", bytes: mqsc },
      { path: "mq/ccdt.json", bytes: ccdt },
    ]);

    expect(result.observations.map((item) => item.coordinate)).toEqual([
      "ibm_mq:queue-manager:PAYQM1:channel:PAY.CLIENT",
      "ibm_mq:queue-manager:unspecified:channel:PAY.CLIENT",
      "ibm_mq:queue-manager:unspecified:queue:PAY.REFUND.IN",
    ]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "messaging/mqsc_missing_queue_manager_coordinate" }),
    );
  });

  it("is deterministic across artifact order", () => {
    const artifacts = [
      { path: "contracts/asyncapi.yaml", bytes: ASYNCAPI },
      {
        path: "kafka/topics.json",
        bytes: JSON.stringify({ clusterId: "c1", topics: [{ name: "refunds" }] }),
      },
    ];
    expect(collectMessagingLegacy(artifacts)).toEqual(
      collectMessagingLegacy([...artifacts].reverse()),
    );
  });

  it("retains conflicting declarations and emits an ambiguity diagnostic", () => {
    const first = JSON.stringify({
      clusterId: "c1",
      topics: [{ name: "refunds", partitions: 3 }],
    });
    const second = JSON.stringify({
      clusterId: "c1",
      topics: [{ name: "refunds", partitions: 9 }],
    });
    const result = collectMessagingLegacy([
      { path: "kafka/a.json", bytes: first },
      { path: "kafka/b.json", bytes: second },
    ]);

    expect(result.observations).toHaveLength(2);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "messaging/ambiguous_coordinate", level: "error" }),
    );
  });

  it.each([
    {
      name: "DOCTYPE/entities",
      artifact: {
        path: "artemis/broker.xml",
        bytes: '<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///etc/passwd">]><configuration/>',
      },
      code: "messaging/forbidden_xml_construct",
    },
    {
      name: "active secrets",
      artifact: {
        path: "rabbit/definitions.json",
        bytes: JSON.stringify({ password: "live-secret", queues: [{ name: "q" }] }),
      },
      code: "messaging/secret_like_value",
    },
    {
      name: "path traversal",
      artifact: { path: "../asyncapi.yaml", bytes: ASYNCAPI },
      code: "messaging/unsafe_artifact_path",
    },
  ])("refuses $name without retaining secret material", ({ artifact, code }) => {
    const result = collectMessagingLegacy([artifact]);
    expect(result.observations).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code, level: "error" }));
    expect(JSON.stringify(result)).not.toContain("live-secret");
    expect(JSON.stringify(result)).not.toContain("file:///etc/passwd");
  });

  it("rejects duplicate paths, malformed documents, and multi-format ambiguity", () => {
    const result = collectMessagingLegacy([
      { path: "same.json", bytes: "{}" },
      { path: "same.json", bytes: "{}" },
      { path: "bad.json", bytes: "{ broken" },
      { path: "ambiguous.json", bytes: JSON.stringify({ queues: [], topics: [] }) },
    ]);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "messaging/ambiguous_artifact_format",
      "messaging/malformed_document",
      "messaging/duplicate_artifact_path",
    ]);
  });

  it("refuses oversized and malformed XML inputs", () => {
    const result = collectMessagingLegacy([
      { path: "artemis/malformed.xml", bytes: "<configuration><address>" },
      { path: "artemis/oversized.xml", bytes: "x".repeat(4 * 1024 * 1024 + 1) },
    ]);
    expect(result.observations).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "messaging/malformed_artemis_xml",
      "messaging/oversized_artifact",
    ]);
  });
});
