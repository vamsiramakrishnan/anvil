import type { z } from "zod";
import {
  CONSOLE_ROUTES,
  type ConsoleResponse,
  type ConsoleRoute,
  type ErrorEnvelope,
} from "../../contract.js";
import type { Fetcher } from "../api.js";
import { fixtureWorkspace, type WorkspaceFixture } from "./fixtures.js";
import { fixtureTask } from "./fixtures-reports.js";

/**
 * An in-process mock of the console contract — NOT of lane 2's server.
 *
 * It answers exactly the routes in `CONSOLE_ROUTES`, enforces the same
 * mutation protections the contract demands (token, JSON body, request
 * schema), and parses every response it emits through the route's response
 * schema before returning it, so a fixture that drifts from the contract is a
 * 500 here rather than a page that happens to render. `vite.config.ts` mounts
 * it under `/api` in dev; the UI tests hand it to the fetch client directly.
 */

export interface MockRequest {
  method: string;
  url: string;
  body?: string;
  headers: Record<string, string>;
}

export interface MockResponse {
  status: number;
  body: unknown;
}

type Routes = typeof CONSOLE_ROUTES;
type RequestBody<R extends ConsoleRoute> = Routes[R] extends { request: infer S extends z.ZodType }
  ? z.infer<S>
  : undefined;
type Handler<R extends ConsoleRoute> = (
  params: Record<string, string>,
  body: RequestBody<R>,
  query: Record<string, string>,
) => ConsoleResponse<R>;

class MockRefusal extends Error {
  constructor(
    readonly status: number,
    readonly envelope: ErrorEnvelope["error"],
  ) {
    super(envelope.message);
  }
}

const refuse = (
  status: number,
  code: string,
  message: string,
  extra: Partial<ErrorEnvelope["error"]> = {},
): MockRefusal => new MockRefusal(status, { code, message, ...extra });

/**
 * The harness protocol's own rejection codes (`@anvil/refinement`,
 * `protocol/errors.ts`), which the real server passes through as 422. Named
 * here rather than spelled at the refusal site so the error-code registry
 * keeps refinement as their owner: the mock imitates them, it does not emit them.
 */
const HARNESS = {
  regressed: "refinement/group_delta_regressed",
  tampered: "refinement/task_integrity_failed",
} as const;

const ROUTE_TABLE = (Object.keys(CONSOLE_ROUTES) as ConsoleRoute[]).map((name) => {
  const def = CONSOLE_ROUTES[name];
  const names: string[] = [];
  const source = def.path.replace(/:([A-Za-z]+)/g, (_, param: string) => {
    names.push(param);
    return "([^/]+)";
  });
  return { name, def, names, pattern: new RegExp(`^${source}$`) };
});

function countBy<T extends string>(values: readonly T[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createMockConsole(
  state: WorkspaceFixture = fixtureWorkspace(),
  token = randomToken(),
) {
  const bundle = (id: string) => {
    const found = state.bundles[id];
    if (!found) throw refuse(404, "console/not_found", `no bundle '${id}' under ${state.root}`);
    return found;
  };

  const reprojection = (
    bundleDir: string,
  ): ConsoleResponse<"approveCapability">["reprojection"] => ({
    bundleDir,
    generatedFileCount: 42,
    projectionsChanged: true,
    stale: { targetFiles: [], records: ["benchmark.report.json"], gatewayReceipt: false },
  });

  const dropQueueItem = (id: string, kind: string, itemId: string) => {
    const b = bundle(id);
    b.queue.items = b.queue.items.filter((item) => !(item.kind === kind && item.id === itemId));
  };

  const handlers: { [R in ConsoleRoute]: Handler<R> } = {
    workspace: () => ({
      root: state.root,
      bundles: Object.entries(state.bundles).map(([id, b]) => ({
        id,
        path: b.inspector.path,
        service: { id: b.inspector.service.id, version: b.inspector.service.version },
        sourceKind: b.inspector.source.kind,
        pathGrammar: b.inspector.pathGrammar?.classification,
        counts: {
          operations: countBy(b.inspector.operations.map((op) => op.state)),
          capabilities: countBy(b.inspector.capabilities.map((cap) => cap.lifecycle)),
          workflows: countBy(b.inspector.workflows.map((wf) => wf.state)),
        },
        hasBenchmark: b.benchmark !== null,
        packs: b.packs.length,
      })),
    }),
    bundle: ({ id = "" }) => bundle(id).inspector,
    queue: ({ id = "" }) => bundle(id).queue,
    packs: ({ id = "" }) => bundle(id).packs,
    benchmark: ({ id = "" }) => bundle(id).benchmark,
    drift: ({ id = "" }, _body, { against = "" }) => {
      const view = bundle(id).drift[against];
      if (!view) {
        throw refuse(404, "console/not_found", `no bundle '${against}' to diff against`);
      }
      return view;
    },

    approveOperations: ({ id = "" }, { ids }) => {
      const b = bundle(id);
      const unknown = ids.filter((opId) => !b.inspector.operations.some((op) => op.id === opId));
      if (unknown.length > 0) {
        throw refuse(409, "console/refused", "unknown operation id(s)", {
          issues: unknown,
        });
      }
      const blocked = b.inspector.operations.filter(
        (op) => ids.includes(op.id) && op.state === "blocked",
      );
      if (blocked.length > 0) {
        throw refuse(409, "console/refused", "blocked operations cannot be approved", {
          issues: blocked.map((op) => `${op.id}: ${op.blockerNotes.join("; ")}`),
        });
      }
      const approved: string[] = [];
      const alreadyApproved: string[] = [];
      for (const op of b.inspector.operations) {
        if (!ids.includes(op.id)) continue;
        if (op.state === "approved") alreadyApproved.push(op.id);
        else {
          op.state = "approved";
          op.blockerNotes = [];
          approved.push(op.id);
          dropQueueItem(id, "operation", op.id);
        }
      }
      return {
        approved,
        alreadyApproved,
        regeneratedFiles: 42,
        reprojection: reprojection(b.inspector.path),
        refusals: [],
      };
    },

    approveCapability: ({ id = "", capId = "" }, { allowLarge, note }) => {
      const b = bundle(id);
      const cap = b.inspector.capabilities.find((c) => c.id === capId);
      if (!cap) throw refuse(404, "capability_not_found", `no capability '${capId}'`);
      if (cap.budget.verdict === "blocked" && !allowLarge) {
        throw refuse(
          409,
          "capability_budget_exceeded",
          "the disclosure budget blocks this approval",
          {
            issues: [cap.budget.diagnostic?.message ?? `${cap.budget.toolCount} tools`],
          },
        );
      }
      if (allowLarge && !note?.trim()) {
        throw refuse(
          409,
          "capability_budget_waiver_note_required",
          "--allow-large requires a non-empty note",
        );
      }
      cap.lifecycle = "approved";
      dropQueueItem(id, "capability", capId);
      return {
        capabilityId: capId,
        budget: cap.budget,
        reprojection: reprojection(b.inspector.path),
      };
    },

    rejectCapability: ({ id = "", capId = "" }) => {
      const b = bundle(id);
      const cap = b.inspector.capabilities.find((c) => c.id === capId);
      if (!cap) throw refuse(404, "capability_not_found", `no capability '${capId}'`);
      cap.lifecycle = "rejected";
      dropQueueItem(id, "capability", capId);
      return { capabilityId: capId, reprojection: reprojection(b.inspector.path) };
    },

    packDecision: ({ id = "", hash = "" }, { decision, refinementIds, reviewer, reason }) => {
      const b = bundle(id);
      const pack = b.packs.find((p) => p.hash === hash);
      if (!pack) throw refuse(409, "console/refused", `no pack with hash ${hash}`);
      const missing = refinementIds.filter(
        (rid) => !pack.items.some((item) => item.refinementId === rid),
      );
      if (missing.length > 0) {
        throw refuse(409, "console/refused", "unknown refinement id(s)", {
          issues: missing,
        });
      }
      const receipts: ConsoleResponse<"packDecision">["receipts"] = [];
      for (const item of pack.items) {
        if (!refinementIds.includes(item.refinementId)) continue;
        item.status = decision === "approve" ? "approved" : "rejected";
        const receipt = {
          schemaVersion: 1 as const,
          service: pack.service,
          sourceContractHash: hash,
          packHash: hash,
          refinementId: item.refinementId,
          proposalHash: hash,
          decision: decision === "approve" ? ("approved" as const) : ("rejected" as const),
          reviewer,
          reason,
          reviewedAt: new Date().toISOString(),
        };
        pack.receipts = [
          ...pack.receipts.filter((r) => r.refinementId !== item.refinementId),
          receipt,
        ];
        const path = `${pack.dir}/receipts/${item.refinementId}.json`;
        item.receiptPaths = [path];
        dropQueueItem(id, "pack", item.refinementId);
        receipts.push({ refinementId: item.refinementId, path, receipt });
      }
      pack.summary = {
        ...pack.summary,
        approved: pack.items.filter((i) => i.status === "approved").length,
        rejected: pack.items.filter((i) => i.status === "rejected").length,
        review: pack.items.filter(
          (i) => i.tier === "review" && i.status !== "approved" && i.status !== "rejected",
        ).length,
      };
      return { receipts };
    },

    applyPack: ({ id = "", hash = "" }, { dryRun }) => {
      const b = bundle(id);
      const pack = b.packs.find((p) => p.hash === hash);
      if (!pack) throw refuse(409, "console/refused", `no pack with hash ${hash}`);
      const applied = pack.items.filter((item) => item.status === "approved");
      if (applied.length === 0) {
        throw refuse(409, "console/refused", "no approved refinement carries a receipt");
      }
      // AIR only, exactly like the server: no reprojection follows a pack apply.
      // A patched field that did not exist before has no `before` side at all.
      return {
        airPath: `${b.inspector.path}/air.yaml`,
        applied: applied.map((item) => item.refinementId),
        changes: applied.map((item) => ({
          target: item.target,
          key: item.patchSummary.split("=")[0] ?? "description",
          after: item.patchSummary.slice(item.patchSummary.indexOf("=") + 1),
        })),
        written: !dryRun,
      };
    },

    exportTask: ({ id = "", clusterId = "" }, { outFile }) => {
      const b = bundle(id);
      if (!b.benchmark?.confusion.clusters.some((c) => c.id === clusterId)) {
        throw refuse(409, "console/refused", `no cluster '${clusterId}' in the benchmark`);
      }
      return {
        taskPath: outFile ?? `${state.root}/tasks/${clusterId}.task.json`,
        task: fixtureTask(clusterId),
      };
    },

    importTask: ({ id = "" }, { taskPath, submissionPath, outDir }) => {
      bundle(id);
      const clusterId = taskPath.split("/").pop()?.replace(".task.json", "") ?? "cluster";
      const numbers = {
        schemaVersion: 1 as const,
        reportType: "anvil.group-routing-delta" as const,
        clusterId,
        proposalKind: "workflow" as const,
        scope: "member_tasks" as const,
        router: "lexical",
        totalTasks: 16,
        hypothetical: {
          catalogSize: 8,
          compositeTool: "lookup_payment",
          supersededOperationIds: [],
        },
        simulated: false as const,
        simulationNote: "hypothetical catalog routed with the same lexical router; not executed",
      };
      if (/regress/.test(submissionPath)) {
        throw refuse(422, HARNESS.regressed, "the proposal routes fewer intents than today", {
          issues: ["passed 11 → 8 on member tasks (-18.8 pts)"],
          delta: {
            ...numbers,
            passedBefore: 11,
            passedAfter: 8,
            upliftPts: -18.8,
            flippedToPass: [],
            flippedToFail: [
              { operationId: "searchPayments", intent: "find the payment for order 8813" },
              { operationId: "listPayments", intent: "what did the customer pay last week" },
              { operationId: "getPayment", intent: "show me payment pay_991" },
            ],
          },
        });
      }
      if (/tamper/.test(submissionPath)) {
        throw refuse(422, HARNESS.tampered, "the submission's taskHash does not match", {
          issues: ["taskHash: expected 3f1a9c7d…, got 00000000…"],
        });
      }
      return {
        taskId: "rt_0123456789abcdef01234567",
        packDir: outDir ?? `${state.root}/packs/imported-${clusterId}`,
        summary: { proposed: 1, approved: 0, review: 1, rejected: 0, regressed: 0, skipped: 0 },
        refinement: { id: `rf_group_${clusterId}`, status: "improved", tier: "review" },
        delta: {
          ...numbers,
          passedBefore: 11,
          passedAfter: 14,
          upliftPts: 18.8,
          flippedToPass: [
            { operationId: "searchPayments", intent: "find the payment for order 8813" },
            { operationId: "listPayments", intent: "what did the customer pay last week" },
            { operationId: "searchPayments", intent: "which payment matches invoice 77" },
          ],
          flippedToFail: [],
        },
      };
    },
  };

  function handle(request: MockRequest): MockResponse {
    const url = new URL(request.url, "http://127.0.0.1");
    const method = request.method.toUpperCase();
    try {
      const hit = ROUTE_TABLE.find((r) => r.def.method === method && r.pattern.test(url.pathname));
      if (!hit)
        throw refuse(404, "console/not_found", `${method} ${url.pathname} is not a console route`);
      const match = hit.pattern.exec(url.pathname) ?? [];
      const params: Record<string, string> = {};
      hit.names.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1] ?? "");
      });

      let body: unknown;
      if (hit.def.mutates) {
        if (request.headers["x-anvil-console-token"] !== token) {
          throw refuse(403, "console/forbidden", "missing or mismatched console token");
        }
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          throw refuse(415, "console/unsupported_media_type", "JSON bodies only");
        }
        let json: unknown;
        try {
          json = JSON.parse(request.body ?? "");
        } catch {
          throw refuse(400, "console/invalid_json", "the body is not JSON");
        }
        const parsed = hit.def.request.safeParse(json);
        if (!parsed.success) {
          throw refuse(400, "console/invalid_request", "the body does not match the contract", {
            issues: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
          });
        }
        body = parsed.data;
      }
      const query = Object.fromEntries(url.searchParams);
      if ("query" in hit.def) {
        const parsed = hit.def.query.safeParse(query);
        if (!parsed.success) {
          throw refuse(400, "console/invalid_request", "the query does not match the contract", {
            issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          });
        }
      }

      const handler = handlers[hit.name] as Handler<ConsoleRoute>;
      const data = handler(params, body as never, query);
      const out = (hit.def.response as z.ZodType).safeParse(data);
      if (!out.success) {
        // A fixture that violates the contract is a bug in the mock, not a refusal: crash loudly.
        throw new Error(
          `${hit.name}: the mock's fixture violates the contract — ${out.error.issues
            .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
            .join("; ")}`,
        );
      }
      return { status: 200, body: out.data };
    } catch (error) {
      if (error instanceof MockRefusal)
        return { status: error.status, body: { error: error.envelope } };
      throw error;
    }
  }

  return { token, state, handle };
}

type MockConsole = ReturnType<typeof createMockConsole>;

/** The mock as a `fetch` for the typed client — what the UI tests run against. */
export function mockFetch(mock: MockConsole): Fetcher {
  return async (url, init) => {
    const headers = new Headers(init.headers);
    const result = mock.handle({
      method: init.method ?? "GET",
      url,
      body: typeof init.body === "string" ? init.body : undefined,
      headers: {
        "x-anvil-console-token": headers.get("X-Anvil-Console-Token") ?? "",
        "content-type": headers.get("Content-Type") ?? "",
      },
    });
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}
