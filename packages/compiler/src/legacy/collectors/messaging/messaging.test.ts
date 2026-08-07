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
        coordinate: "asyncapi:Refund Events:operation:PAY.REFUND.REQUEST:publish",
        binding: {
          kind: "jms",
          config: expect.objectContaining({
            action: "publish",
            channelKey: "PAY.REFUND.REQUEST",
            operationId: "submitRefund",
            messageRefs: ["#/components/messages/RefundCommand"],
          }),
        },
      }),
    );
  });

  it("keeps AsyncAPI 3 logical channel and operation keys distinct from a shared address", () => {
    const result = collectMessagingLegacy([
      {
        path: "contracts/request-reply.yaml",
        bytes: `asyncapi: 3.0.0
info:
  title: Payments socket
  version: 1.0.0
channels:
  refundCommands:
    address: /
    messages:
      RefundCommand:
        $ref: '#/components/messages/RefundCommand'
  refundReplies:
    address: /
    messages:
      RefundReply:
        $ref: '#/components/messages/RefundReply'
operations:
  submitRefund:
    action: send
    channel:
      $ref: '#/channels/refundCommands'
    messages:
      - $ref: '#/components/messages/RefundCommand'
    reply:
      channel:
        $ref: '#/channels/refundReplies'
      messages:
        - $ref: '#/components/messages/RefundReply'
components:
  messages:
    RefundCommand:
      messageId: refund-command
      contentType: application/json
      correlationId:
        location: '$message.header#/correlationId'
      payload:
        type: object
        discriminator:
          propertyName: commandType
    RefundReply:
      payload:
        type: object
`,
      },
    ]);

    expect(result.diagnostics).toEqual([]);
    expect(result.observations.map((item) => item.coordinate)).toEqual([
      "asyncapi:Payments socket:channel:refundCommands",
      "asyncapi:Payments socket:channel:refundReplies",
      "asyncapi:Payments socket:operation:submitRefund",
    ]);
    expect(result.observations[0]?.binding.config).toMatchObject({
      channelKey: "refundCommands",
      address: "/",
    });
    expect(result.observations[2]?.binding.config).toMatchObject({
      operationKey: "submitRefund",
      channelKey: "refundCommands",
      address: "/",
      correlationLocations: ["$message.header#/correlationId"],
      discriminatorProperties: ["commandType"],
      messageIds: ["refund-command"],
      contentTypes: ["application/json"],
      replyChannel: "refundReplies",
      replyAddress: "/",
      replyMessageRefs: ["#/components/messages/RefundReply"],
    });
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

  it("collects Strimzi KafkaTopic and KafkaConnector resources through an allowlisted projection", () => {
    const result = collectMessagingLegacy([
      {
        path: "strimzi/topic.yaml",
        bytes: `apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: refunds
  labels:
    strimzi.io/cluster: payments
spec:
  topicName: refund.commands
  partitions: 12
  replicas: 3
  config:
    retention.ms: 604800000
    unclean.leader.election.enable: true
`,
      },
      {
        path: "strimzi/connector.yaml",
        bytes: `apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaConnector
metadata:
  name: refund-source
  labels:
    strimzi.io/cluster: payments-connect
spec:
  class: io.example.RefundSourceConnector
  tasksMax: 4
  config:
    topics: refund.commands, refund.audit
    errors.deadletterqueue.topic.name: refund.dlq
    password: do-not-retain-this
`,
      },
    ]);

    expect(result.observations.map((item) => item.coordinate)).toEqual([
      "kafka-connect:cluster:payments-connect:connector:refund-source",
      "kafka:cluster:payments:topic:refund.commands",
    ]);
    expect(result.observations[0]?.binding.config).toMatchObject({
      action: "publish",
      topics: ["refund.audit", "refund.commands"],
      deadLetterQueue: "refund.dlq",
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "messaging/kafka_safe_projection_applied", level: "info" }),
    );
    expect(JSON.stringify(result)).not.toContain("do-not-retain-this");
    expect(JSON.stringify(result)).not.toContain('"password"');
    expect(JSON.stringify(result)).not.toContain("unclean.leader.election.enable");
  });

  it("collects common Kafka Admin and Schema Registry response shapes", () => {
    const result = collectMessagingLegacy([
      {
        path: "kafka/admin.json",
        bytes: JSON.stringify({
          kind: "KafkaTopicList",
          data: [
            {
              cluster_id: "payments-prod",
              topic_name: "refund.events",
              partitions_count: 9,
              replication_factor: 3,
            },
          ],
        }),
      },
      {
        path: "schema-registry/refund-value.json",
        bytes: JSON.stringify({
          subject: "refund.events-value",
          version: 7,
          id: 42,
          schemaType: "AVRO",
          references: [{ name: "money.avsc", subject: "money-value", version: 2 }],
          schema: '{"type":"record","name":"RefundEvent"}',
        }),
      },
    ]);

    expect(result.observations.map((item) => item.coordinate)).toEqual([
      "kafka:cluster:payments-prod:topic:refund.events",
      "kafka:cluster:unspecified:schema-subject:refund.events-value",
    ]);
    expect(result.observations[1]?.binding.config).toMatchObject({
      format: "avro",
      schemaId: 42,
      version: 7,
      references: [{ name: "money.avsc", subject: "money-value", version: 2 }],
    });
    expect(result.observations[1]?.binding.config.schemaDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain("RefundEvent");
  });

  it("projects RabbitMQ topology while excluding users, credentials, and permissions", () => {
    const result = collectMessagingLegacy([
      {
        path: "rabbit/definitions.json",
        bytes: JSON.stringify({
          users: [{ name: "ops", password_hash: "credential-hash", tags: "administrator" }],
          permissions: [{ user: "ops", vhost: "/", configure: ".*", write: ".*", read: ".*" }],
          queues: [{ name: "refund.in", durable: true }],
          exchanges: [{ name: "refunds", type: "topic", durable: true }],
          bindings: [
            {
              source: "refunds",
              destination: "refund.in",
              destination_type: "queue",
              routing_key: "refund.requested",
            },
          ],
        }),
      },
    ]);

    expect(result.observations).toHaveLength(3);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "messaging/rabbitmq_safe_projection_applied",
        level: "info",
      }),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("credential-hash");
    expect(serialized).not.toContain('"users"');
    expect(serialized).not.toContain('"permissions"');
    expect(serialized).not.toContain('"password_hash"');
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
        bytes: JSON.stringify({ users: [{ name: "ops", password: "live-secret" }] }),
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
