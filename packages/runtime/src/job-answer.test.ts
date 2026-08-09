import { type Operation, Operation as OperationSchema } from "@anvil/air";
import { describe, expect, it } from "vitest";
import type { ExecuteContext } from "./executor.js";
import { InMemoryLedger } from "./idempotency.js";
import type { InboundIdentity } from "./inbound-identity.js";
import { handleJobAnswer } from "./job-answer.js";
import { type HttpResponse, MockTransport } from "./transport.js";

/** A real "approve this application"-shaped upstream decision operation. */
function decisionOperation(overrides: Partial<Operation> = {}): Operation {
  return OperationSchema.parse({
    id: "loans.applications.decide",
    canonicalName: "decide_loan_application",
    displayName: "Decide loan application",
    sourceRef: { kind: "openapi", path: "/applications/{id}/decision", method: "post" },
    effect: {
      kind: "mutation",
      resource: "loan_application",
      risk: "financial",
      reversible: false,
    },
    input: {
      params: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      body: {
        contentType: "application/json",
        required: true,
        schema: {
          type: "object",
          required: ["decision"],
          properties: { decision: { type: "string" }, note: { type: "string" } },
        },
        projection: "fields",
        fields: [
          { name: "decision", required: true, schema: { type: "string" } },
          { name: "note", required: false, schema: { type: "string" } },
        ],
      },
    },
    idempotency: { mode: "none" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: false },
    auth: { type: "none", principal: "end_user", scopes: ["loans:decide"] },
    cli: { command: "loans applications decide" },
    mcp: { toolName: "loans_decide_application" },
    skill: { intentExamples: [] },
    state: "approved",
    ...overrides,
  });
}

const success = (): HttpResponse => ({
  status: 200,
  headers: {},
  body: '{"applicationId":"app-1","decision":"approved"}',
});

function baseContext(transport: MockTransport): ExecuteContext {
  return {
    transport,
    serviceId: "loans-service",
    baseUrl: "https://loans.example.com",
    ledger: new InMemoryLedger(),
    env: "dev",
  };
}

const authorizedCaller: InboundIdentity = {
  subjectToken: "caller-token",
  subjectTokenType: "access_token",
  sub: "underwriter-1",
  scope: "loans:decide other:scope",
};

describe("handleJobAnswer", () => {
  it("valid decision + authorized caller calls the upstream decision operation with the right arguments", async () => {
    const transport = new MockTransport(() => success());
    const result = await handleJobAnswer({
      operation: decisionOperation(),
      caller: authorizedCaller,
      decision: "approve",
      note: "looks good",
      jobId: "app-1",
      buildOperationInput: ({ decision, note, jobId }) => ({
        id: jobId,
        decision: decision === "approve" ? "approved" : "rejected",
        note,
      }),
      executeContext: baseContext(transport),
    });

    expect(result.outcome).toBe("answered");
    expect(transport.requests).toHaveLength(1);
    const request = transport.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toContain("/applications/app-1/decision");
    expect(JSON.parse(request?.body ?? "{}")).toEqual({ decision: "approved", note: "looks good" });
  });

  it("unauthorized caller is rejected before any upstream call", async () => {
    const transport = new MockTransport(() => success());
    const unauthorizedCaller: InboundIdentity = {
      subjectToken: "caller-token",
      subjectTokenType: "access_token",
      sub: "random-user",
      scope: "some:other:scope",
    };
    const result = await handleJobAnswer({
      operation: decisionOperation(),
      caller: unauthorizedCaller,
      decision: "approve",
      jobId: "app-1",
      buildOperationInput: ({ decision, jobId }) => ({ id: jobId, decision }),
      executeContext: baseContext(transport),
    });

    expect(result.outcome).toBe("unauthorized");
    expect(transport.requests).toHaveLength(0);
  });

  it("a missing caller identity is rejected before any upstream call when the operation requires one", async () => {
    const transport = new MockTransport(() => success());
    const result = await handleJobAnswer({
      operation: decisionOperation(),
      caller: undefined,
      decision: "approve",
      jobId: "app-1",
      buildOperationInput: ({ decision, jobId }) => ({ id: jobId, decision }),
      executeContext: baseContext(transport),
    });

    expect(result.outcome).toBe("unauthorized");
    expect(transport.requests).toHaveLength(0);
  });

  it("a service-principal operation requires no caller identity", async () => {
    const transport = new MockTransport(() => success());
    const result = await handleJobAnswer({
      operation: decisionOperation({
        auth: { type: "none", scopes: [], principal: "service", secretSource: "none" },
      }),
      caller: undefined,
      decision: "reject",
      jobId: "app-2",
      buildOperationInput: ({ decision, jobId }) => ({ id: jobId, decision }),
      executeContext: baseContext(transport),
    });

    expect(result.outcome).toBe("answered");
    expect(transport.requests).toHaveLength(1);
  });

  it("an invalid decision value is rejected before any upstream call, regardless of authorization", async () => {
    const transport = new MockTransport(() => success());
    const result = await handleJobAnswer({
      operation: decisionOperation(),
      caller: authorizedCaller,
      // @ts-expect-error deliberately invalid at the boundary this function must validate
      decision: "maybe",
      jobId: "app-1",
      buildOperationInput: ({ decision, jobId }) => ({ id: jobId, decision }),
      executeContext: baseContext(transport),
    });

    expect(result.outcome).toBe("invalid_decision");
    expect(transport.requests).toHaveLength(0);
  });

  it("an empty job id is rejected before any upstream call", async () => {
    const transport = new MockTransport(() => success());
    const result = await handleJobAnswer({
      operation: decisionOperation(),
      caller: authorizedCaller,
      decision: "approve",
      jobId: "   ",
      buildOperationInput: ({ decision, jobId }) => ({ id: jobId, decision }),
      executeContext: baseContext(transport),
    });

    expect(result.outcome).toBe("invalid_decision");
    expect(transport.requests).toHaveLength(0);
  });

  it("a decision operation that isn't approved is refused before any upstream call", async () => {
    const transport = new MockTransport(() => success());
    const result = await handleJobAnswer({
      operation: decisionOperation({ state: "review_required" }),
      caller: authorizedCaller,
      decision: "approve",
      jobId: "app-1",
      buildOperationInput: ({ decision, jobId }) => ({ id: jobId, decision }),
      executeContext: baseContext(transport),
    });

    expect(result.outcome).toBe("invalid_decision");
    expect(transport.requests).toHaveLength(0);
  });
});
