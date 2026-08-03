import { describe, expect, it } from "vitest";
import { normalize } from "./normalize.js";
import { parseSpec } from "./parse.js";

/**
 * Long-running detection and contract linkage, tested through the whole
 * normalize path rather than against the classifier in isolation — the response
 * headers and the 202 that carry nearly all of the evidence only exist in the
 * source document, so a unit test that hand-builds `AsyncResponseSignals` would
 * prove the rule without proving that the compiler ever sees the facts.
 *
 * The negative cases carry as much weight as the positive ones. A false positive
 * tells an agent to poll a call that already answered; a *partial* contract sends
 * it round a loop it has no way to leave. Both are worse than the silence this
 * pass is allowed to fall back to, so each is pinned here.
 */

const doc = (paths: Record<string, unknown>) => ({
  openapi: "3.0.3",
  info: { title: "Async", version: "1.0.0" },
  paths,
});

const ops = async (paths: Record<string, unknown>) => {
  const parsed = await parseSpec(JSON.stringify(doc(paths)));
  const { operations } = normalize("svc", parsed);
  return new Map(operations.map((op) => [op.sourceRef.path ?? op.id, op]));
};

const json = (properties: Record<string, unknown>) => ({
  "application/json": { schema: { type: "object", properties } },
});

/** The Azure convention: 202 + Operation-Location + a declared Retry-After. */
const azure = {
  "/documents/analyze": {
    post: {
      operationId: "analyzeDocument",
      summary: "Analyze a document",
      responses: {
        "202": {
          description: "Accepted",
          headers: {
            "Operation-Location": { schema: { type: "string" } },
            "Retry-After": { schema: { type: "integer", default: 5 } },
          },
          content: json({ operationId: { type: "string" } }),
        },
      },
    },
  },
  "/documents/analyzeStatus/{operationId}": {
    get: {
      operationId: "getAnalyzeStatus",
      parameters: [{ name: "operationId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "OK",
          content: json({
            status: { type: "string", enum: ["notStarted", "running", "succeeded", "failed"] },
          }),
        },
      },
    },
  },
};

/** The plainest shape in the wild: submit a job, read the job back by id. */
const jobPair = {
  "/jobs": {
    post: {
      operationId: "createJob",
      responses: {
        "202": { description: "Accepted", content: json({ job_id: { type: "string" } }) },
      },
    },
  },
  "/jobs/{jobId}": {
    get: {
      operationId: "getJob",
      parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "OK",
          content: json({
            state: { type: "string", enum: ["queued", "running", "completed", "failed"] },
          }),
        },
      },
    },
  },
  // A mutation that accepts the same handle. It must never be chosen as the poll
  // target: polling repeats by definition, so a cancel would be applied on loop.
  "/jobs/{jobId}/cancel": {
    post: {
      operationId: "cancelJob",
      parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
      responses: { "200": { description: "OK" } },
    },
  },
};

describe("long-running detection", () => {
  it("reads an Azure-style 202 + Operation-Location as long-running and links the poll", async () => {
    const found = await ops(azure);
    const submit = found.get("/documents/analyze");
    expect(submit?.longRunning).toBe(true);
    expect(submit?.archetype).toBe("long_running");
    expect(submit?.asyncContract).toEqual({
      statusOperationId: found.get("/documents/analyzeStatus/{operationId}")?.id,
      jobIdField: "operationId",
      statusJobIdParam: "operationId",
      stateField: "status",
      // Declaration order is preserved, and only declared values appear.
      terminalStates: ["succeeded", "failed"],
      pendingStates: ["notStarted", "running"],
      // Stated by the document's own Retry-After default — never inferred.
      pollIntervalSeconds: 5,
    });
  });

  it("links a job-submit/job-status pair and never polls a mutation", async () => {
    const found = await ops(jobPair);
    const submit = found.get("/jobs");
    expect(submit?.longRunning).toBe(true);
    expect(submit?.asyncContract).toEqual({
      statusOperationId: found.get("/jobs/{jobId}")?.id,
      jobIdField: "job_id",
      // The wire casing the status route declared, not the handle's spelling.
      statusJobIdParam: "jobId",
      stateField: "state",
      terminalStates: ["completed", "failed"],
      pendingStates: ["queued", "running"],
    });
    // The read was chosen over the cancel that accepts the very same parameter.
    expect(submit?.asyncContract?.statusOperationId).not.toBe(
      found.get("/jobs/{jobId}/cancel")?.id,
    );
  });

  it("resolves identically when the status route is declared first", async () => {
    // `paths` order is arbitrary in a document, and the status operation is
    // normalized after the submit in one ordering and before it in the other.
    // The linkage runs over the finished operation set precisely so the compiler
    // cannot produce two different answers for the same API.
    const forward = await ops(jobPair);
    const reversed = await ops({
      "/jobs/{jobId}": jobPair["/jobs/{jobId}"],
      "/jobs/{jobId}/cancel": jobPair["/jobs/{jobId}/cancel"],
      "/jobs": jobPair["/jobs"],
    });
    expect(reversed.get("/jobs")?.asyncContract).toEqual(forward.get("/jobs")?.asyncContract);
  });

  it("records the declared evidence behind the flag", async () => {
    const submit = (await ops(azure)).get("/documents/analyze");
    const claim = submit?.evidence.claims.find((c) => c.predicate === "longRunning");
    expect(claim?.source).toBe("spec");
    expect(claim?.note).toContain("202 Accepted");
    expect(claim?.note).toContain("Operation-Location");
  });
});

describe("a contract is omitted rather than half-stated", () => {
  it("flags a 202 with no status route but attaches no contract", async () => {
    const found = await ops({ "/jobs": jobPair["/jobs"] });
    const submit = found.get("/jobs");
    // The flag is still true — the call really does return before it finishes,
    // and the agent is better off knowing that than being told nothing.
    expect(submit?.longRunning).toBe(true);
    // …but there is nothing to poll, so no coordinates are invented.
    expect(submit?.asyncContract).toBeUndefined();
  });

  it("attaches nothing when the status field declares no enum", async () => {
    const found = await ops({
      ...jobPair,
      "/jobs/{jobId}": {
        get: {
          operationId: "getJob",
          parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            // A status field with no declared values. Guessing "succeeded"/"failed"
            // here is the failure the whole shape exists to prevent: wrong terminal
            // states either stop the agent early or never stop it at all.
            "200": { description: "OK", content: json({ state: { type: "string" } }) },
          },
        },
      },
    });
    expect(found.get("/jobs")?.longRunning).toBe(true);
    expect(found.get("/jobs")?.asyncContract).toBeUndefined();
  });

  it("attaches nothing when no declared state value is recognizably terminal", async () => {
    const found = await ops({
      ...jobPair,
      "/jobs/{jobId}": {
        get: {
          operationId: "getJob",
          parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "OK",
              content: json({ state: { type: "string", enum: ["alpha", "beta"] } }),
            },
          },
        },
      },
    });
    expect(found.get("/jobs")?.asyncContract).toBeUndefined();
  });

  it("keeps a contract when only some declared states are recognized", async () => {
    const found = await ops({
      ...jobPair,
      "/jobs/{jobId}": {
        get: {
          operationId: "getJob",
          parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "OK",
              content: json({
                state: { type: "string", enum: ["queued", "superseded", "completed"] },
              }),
            },
          },
        },
      },
    });
    // "superseded" is listed as neither terminal nor pending: an unlisted state
    // leaves the agent polling, which fails visibly, where calling it terminal
    // would hand back a half-finished job as a complete one.
    expect(found.get("/jobs")?.asyncContract?.terminalStates).toEqual(["completed"]);
    expect(found.get("/jobs")?.asyncContract?.pendingStates).toEqual(["queued"]);
  });

  it("attaches nothing when two fields could be the job handle", async () => {
    const found = await ops({
      ...jobPair,
      "/jobs": {
        post: {
          operationId: "createJob",
          responses: {
            "202": {
              description: "Accepted",
              content: json({ job_id: { type: "string" }, task_id: { type: "string" } }),
            },
          },
        },
      },
    });
    // Which one does the status route want? The document does not say, and a
    // coin flip is a value the agent would then poll with.
    expect(found.get("/jobs")?.asyncContract).toBeUndefined();
  });
});

describe("synchronous operations are left alone", () => {
  it("leaves an ordinary create synchronous", async () => {
    const found = await ops({
      "/widgets": {
        post: {
          operationId: "createWidget",
          responses: {
            "201": { description: "Created", content: json({ id: { type: "string" } }) },
          },
        },
      },
      "/widgets/{id}": {
        get: {
          operationId: "getWidget",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "OK",
              content: json({ status: { type: "string", enum: ["active", "failed"] } }),
            },
          },
        },
      },
    });
    const create = found.get("/widgets");
    expect(create?.longRunning).toBe(false);
    expect(create?.asyncContract).toBeUndefined();
    expect(create?.archetype).toBe("transaction");
  });

  it("does not read a 201 Location as asynchrony", async () => {
    // RFC 9110 gives Location two meanings by status: on a 201 it is the created
    // resource — an ordinary synchronous create, and the single largest source of
    // false positives in this area.
    const found = await ops({
      "/widgets": {
        post: {
          operationId: "createWidget",
          responses: {
            "201": {
              description: "Created",
              headers: { Location: { schema: { type: "string" } } },
              content: json({ id: { type: "string" } }),
            },
          },
        },
      },
    });
    expect(found.get("/widgets")?.longRunning).toBe(false);
  });

  it("reads Location on a 202 as a status monitor", async () => {
    const found = await ops({
      "/jobs": {
        post: {
          operationId: "createJob",
          responses: {
            "202": {
              description: "Accepted",
              headers: { Location: { schema: { type: "string" } } },
              content: json({ job_id: { type: "string" } }),
            },
          },
        },
      },
    });
    expect(found.get("/jobs")?.longRunning).toBe(true);
  });

  it("never marks a read long-running, even when it declares a 202", async () => {
    // A status route may itself answer 202 while the work runs. Marking it would
    // tell an agent to poll the poller and would replace its read archetype.
    const found = await ops({
      "/jobs/{jobId}": {
        get: {
          operationId: "getJobStatus",
          parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "202": { description: "Still running" },
            "200": { description: "OK", content: json({ state: { type: "string" } }) },
          },
        },
      },
    });
    expect(found.get("/jobs/{jobId}")?.longRunning).toBe(false);
  });

  it("does not treat a name as evidence of asynchrony", async () => {
    // `async`/`batch`/`export` in a name assert nothing about when the work
    // finishes; only the declared response does.
    const found = await ops({
      "/exports/batchAsync": {
        post: {
          operationId: "startBatchExportAsync",
          responses: {
            "200": { description: "OK", content: json({ job_id: { type: "string" } }) },
          },
        },
      },
    });
    expect(found.get("/exports/batchAsync")?.longRunning).toBe(false);
  });
});
