import { describe, expect, it } from "vitest";
import {
  collectLegacyInventory,
  collectLegacyInventoryStream,
  type LegacySourceMember,
} from "./inventory.js";

const encoder = new TextEncoder();

function member(path: string, content: string): LegacySourceMember {
  return { path, bytes: encoder.encode(content) };
}

function inventory(members: LegacySourceMember[]) {
  return collectLegacyInventory({
    estate: { id: "refunds-prod" },
    environment: "prod",
    application: "refund-service",
    source: { kind: "deployed_configuration", systemId: "offline-export" },
    members,
  });
}

describe("legacy collector normalization", () => {
  it("turns competing Java EE physical bindings into one explicit claim conflict", () => {
    const result = inventory([
      member(
        "refunds/META-INF/ejb-jar.xml",
        `<ejb-jar><enterprise-beans><session>
          <ejb-name>RefundBean</ejb-name><remote>com.acme.Refunds</remote>
        </session></enterprise-beans></ejb-jar>`,
      ),
      member(
        "refunds/META-INF/weblogic-ejb-jar.xml",
        `<weblogic-ejb-jar><weblogic-enterprise-bean>
          <ejb-name>RefundBean</ejb-name><jndi-name>ejb/refunds-v1</jndi-name>
        </weblogic-enterprise-bean></weblogic-ejb-jar>`,
      ),
      member(
        "refunds/META-INF/weblogic-bindings.xml",
        `<weblogic-ejb-jar><weblogic-enterprise-bean>
          <ejb-name>RefundBean</ejb-name><jndi-name>ejb/refunds-v2</jndi-name>
        </weblogic-enterprise-bean></weblogic-ejb-jar>`,
      ),
    ]);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.invocation).toEqual({
      kind: "remote_method",
      protocol: "ejb_rmi",
      interface: "com.acme.Refunds",
    });
    expect(result.candidates[0]?.conflicts).toContainEqual(
      expect.objectContaining({
        dimension: "binding_target",
        values: ["ejb/refunds-v1", "ejb/refunds-v2"],
      }),
    );
    expect(result.candidates[0]?.disposition).toBe("triage");
  });

  it("does not turn a local-only EJB or deployment metadata into a callable candidate", () => {
    const result = inventory([
      member(
        "pricing/META-INF/ejb-jar.xml",
        `<ejb-jar><enterprise-beans><session>
          <ejb-name>PriceRules</ejb-name><local>com.acme.PriceRulesLocal</local>
        </session></enterprise-beans></ejb-jar>`,
      ),
      member(
        "dotnet-deployment.json",
        JSON.stringify({ windowsServices: [{ name: "PriceWorker", startType: "auto" }] }),
      ),
    ]);

    expect(result.candidates).toEqual([]);
    expect(result.snapshot.diagnostics).toContainEqual(
      expect.objectContaining({ code: "legacy/java-ee/local_only_ejb" }),
    );
  });

  it("captures WCF and messaging invocations without inventing business semantics", () => {
    const result = inventory([
      member(
        "refund-worker.exe.config",
        `<configuration><system.serviceModel><services><service name="RefundService">
          <endpoint name="refunds" address="net.tcp://legacy/refunds"
            binding="netTcpBinding" contract="Acme.IRefunds" />
        </service></services></system.serviceModel></configuration>`,
      ),
      member(
        "asyncapi.yaml",
        `asyncapi: 3.0.0
info:
  title: Refund events
channels:
  refundCommands:
    address: refunds.commands
operations:
  submitRefund:
    action: send
    channel:
      $ref: '#/channels/refundCommands'
`,
      ),
    ]);

    expect(
      result.candidates.some((candidate) => candidate.invocation.kind === "remote_method"),
    ).toBe(true);
    expect(result.candidates.some((candidate) => candidate.invocation.kind === "message")).toBe(
      true,
    );
    expect(result.candidates.every((candidate) => candidate.businessSemantics === "unknown")).toBe(
      true,
    );
    expect(
      result.candidates
        .flatMap((candidate) => candidate.claims)
        .some((claim) =>
          ["business_operation", "business_effect", "idempotency"].includes(claim.dimension),
        ),
    ).toBe(false);
  });

  it("keeps AsyncAPI logical identity separate from a shared address and retains reply schemas", () => {
    const result = inventory([
      member(
        "contracts.yaml",
        `asyncapi: 3.0.0
info:
  title: Refund RPC
channels:
  refundRequests:
    address: /
    messages:
      request:
        $ref: '#/components/messages/RefundRequest'
  refundReplies:
    address: /
    messages:
      reply:
        $ref: '#/components/messages/RefundReply'
operations:
  submitRefund:
    action: send
    channel:
      $ref: '#/channels/refundRequests'
    messages:
      - $ref: '#/components/messages/RefundRequest'
    reply:
      channel:
        $ref: '#/channels/refundReplies'
      messages:
        - $ref: '#/components/messages/RefundReply'
components:
  messages:
    RefundRequest:
      name: RefundRequest
      payload: { type: object }
    RefundReply:
      name: RefundReply
      payload: { type: object }
`,
      ),
    ]);

    const operation = result.candidates.find(
      (candidate) =>
        candidate.invocation.kind === "message" &&
        candidate.invocation.direction === "request_reply",
    );
    expect(operation?.invocation).toMatchObject({
      destination: "refundRequests",
      direction: "request_reply",
    });
    expect(operation?.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: "binding_target" }),
        expect.objectContaining({ dimension: "input_schema" }),
        expect.objectContaining({ dimension: "output_schema" }),
      ]),
    );
    const binding = operation?.claims.find((claim) => claim.dimension === "binding_target");
    expect(binding?.assertions[0]?.value).toBe("/");
  });

  it("retains schema-only evidence and reports that no invocation was proved", () => {
    const result = inventory([
      member(
        "schema-registry.json",
        JSON.stringify({
          subjects: [
            {
              subject: "refund-value",
              schemaType: "AVRO",
              version: 4,
              schema: '{"type":"record","name":"Refund"}',
            },
          ],
        }),
      ),
    ]);

    expect(result.snapshot.evidence).toHaveLength(1);
    expect(result.candidates).toEqual([]);
    expect(result.collectors).toContainEqual(
      expect.objectContaining({ collector: "messaging", observations: 0, diagnostics: 1 }),
    );
    expect(result.snapshot.diagnostics).toContainEqual(
      expect.objectContaining({ code: "legacy/messaging/no_invocation_candidate" }),
    );
  });

  it("is content-addressed and independent of caller member ordering", () => {
    const members = [
      member("queues.mqsc", "DEFINE QLOCAL('REFUND.REQUESTS') DEFPSIST(YES)"),
      member("notes.txt", "operator note"),
    ];
    const left = inventory(members);
    const right = inventory([...members].reverse());

    expect(left).toEqual(right);
    expect(left.snapshot.inventoryId).toMatch(/^li_[a-f0-9]{64}$/);
    expect(left.snapshot.artifacts).toHaveLength(2);
  });

  it("preserves per-member provenance without laundering source authority", () => {
    const result = inventory([
      {
        ...member(
          "refunds/META-INF/ejb-jar.xml",
          `<ejb-jar><enterprise-beans><session><ejb-name>RefundBean</ejb-name><remote>com.acme.Refunds</remote></session></enterprise-beans></ejb-jar>`,
        ),
        source: {
          kind: "source_repository",
          systemId: "refunds-git",
          revision: "commit-123",
        },
      },
      {
        ...member(
          "refunds/META-INF/weblogic-ejb-jar.xml",
          `<weblogic-ejb-jar><weblogic-enterprise-bean><ejb-name>RefundBean</ejb-name><jndi-name>ejb/refunds</jndi-name></weblogic-enterprise-bean></weblogic-ejb-jar>`,
        ),
        source: {
          kind: "deployed_configuration",
          systemId: "weblogic-prod",
          revision: "export-456",
        },
      },
    ]);

    expect(result.snapshot.artifacts.map((artifact) => artifact.source)).toEqual(
      expect.arrayContaining([
        {
          kind: "source_repository",
          systemId: "refunds-git",
          revision: "commit-123",
        },
        {
          kind: "deployed_configuration",
          systemId: "weblogic-prod",
          revision: "export-456",
        },
      ]),
    );
    expect(new Set(result.snapshot.evidence.map((evidence) => evidence.sourceKind))).toEqual(
      new Set(["source_repository", "deployed_configuration"]),
    );
  });

  it("collects asynchronous member streams deterministically with hard limits", async () => {
    const members = [member("queues.mqsc", "DEFINE QLOCAL('REFUND.REQUESTS')")];
    async function* source() {
      for (const item of members) yield item;
    }
    const streamed = await collectLegacyInventoryStream({
      estate: { id: "refunds-prod" },
      environment: "prod",
      application: "refund-service",
      source: { kind: "broker_configuration", systemId: "mq-export" },
      members: source(),
    });
    const direct = collectLegacyInventory({
      estate: { id: "refunds-prod" },
      environment: "prod",
      application: "refund-service",
      source: { kind: "broker_configuration", systemId: "mq-export" },
      members,
    });
    expect(streamed).toEqual(direct);

    await expect(
      collectLegacyInventoryStream({
        estate: { id: "refunds-prod" },
        environment: "prod",
        application: "refund-service",
        source: { kind: "broker_configuration", systemId: "mq-export" },
        members: source(),
        limits: { maxMemberBytes: 4 },
      }),
    ).rejects.toThrow("exceeds 4 bytes");
  });
});
