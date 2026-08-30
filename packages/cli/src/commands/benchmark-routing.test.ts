import { type Operation, Operation as OperationSchema } from "@anvil/air";
import type { AgentProcessRunner } from "@anvil/refinement";
import { describe, expect, it } from "vitest";
import {
  agentRouter,
  bareCatalog,
  benchmarkOperations,
  curatedCatalog,
  extractRoutedTool,
  lexicalRouter,
  routeAndScore,
} from "./benchmark-routing.js";

/**
 * The routing core, tested pure: catalogs in, tool name out, no bundle on
 * disk. The command-level tests drive the same code through real compiled
 * bundles; these pin the properties the score's meaning rests on —
 * determinism, the bare baseline being genuinely bare, and the agent seam
 * failing closed.
 */

function op(overrides: Record<string, unknown> = {}): Operation {
  return OperationSchema.parse({
    id: "payments.refund.create",
    canonicalName: "create_refund",
    displayName: "Create a refund",
    description: "Refund a captured payment to the original payment method.",
    sourceRef: { kind: "openapi", path: "/refunds", method: "post", operationId: "postRefunds" },
    effect: { kind: "mutation", resource: "refund", risk: "financial", reversible: false },
    input: { params: [] },
    idempotency: { mode: "required", keyDerivation: "client_supplied" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: true },
    auth: { type: "none", scopes: [] },
    cli: { command: "payments refund create" },
    mcp: { toolName: "payments_create_refund" },
    skill: { intentExamples: [] },
    state: "approved",
    ...overrides,
  });
}

const REFUND = op();
const LOOKUP = op({
  id: "payments.payment.get",
  canonicalName: "get_payment",
  displayName: "Get a payment",
  description: "Fetch one payment by its identifier.",
  sourceRef: { kind: "openapi", path: "/payments/{id}", method: "get", operationId: "getPayment" },
  effect: { kind: "read", resource: "payment", risk: "none", reversible: true },
  idempotency: { mode: "natural", keyDerivation: "none" },
  retries: { mode: "safe", maxAttempts: 2, backoff: "exponential_jitter", retryOn: ["http_503"] },
  confirmation: { required: false },
  cli: { command: "payments payment get" },
  mcp: { toolName: "payments_get_payment" },
});

describe("the two catalogs", () => {
  it("serves the curated catalog exactly as the MCP server describes tools", () => {
    const [refund] = curatedCatalog([REFUND]);
    expect(refund?.name).toBe("payments_create_refund");
    // The compiled description, safety sentences included — the benchmark must
    // measure the surface a real agent sees, not a paraphrase of it.
    expect(refund?.description).toContain("Refund a captured payment");
    expect(refund?.description).toContain("irreversible financial mutation");
  });

  it("keeps the bare catalog genuinely bare: source names, no authored text", () => {
    const [refund] = bareCatalog([REFUND]);
    expect(refund?.name).toBe("postRefunds");
    expect(refund?.description).toBe("");
    // No declared operationId → the raw method and path, which is all the
    // source supplies.
    const [anon] = bareCatalog([
      op({ sourceRef: { kind: "openapi", path: "/refunds", method: "post" } }),
    ]);
    expect(anon?.name).toBe("POST /refunds");
  });
});

describe("the lexical router", () => {
  const catalog = curatedCatalog([REFUND, LOOKUP]);

  it("routes an intent by its distinctive tokens", async () => {
    expect(await lexicalRouter().route("refund the customer's payment", catalog)).toBe(
      "payments_create_refund",
    );
    expect(await lexicalRouter().route("look up the status of a payment", catalog)).toBe(
      "payments_get_payment",
    );
  });

  it("routes nothing when the intent shares no vocabulary with any tool", async () => {
    expect(await lexicalRouter().route("reticulate the splines", catalog)).toBeUndefined();
  });

  it("is deterministic on ties, so the score cannot flake", async () => {
    // Two tools that match an ambiguous intent identically must resolve the
    // same way every run: lexicographically by name.
    const twins = [
      { name: "b_twin", description: "handles the widget", operationId: "b" },
      { name: "a_twin", description: "handles the widget", operationId: "a" },
    ];
    for (let i = 0; i < 3; i++) {
      expect(await lexicalRouter().route("widget", twins)).toBe("a_twin");
    }
  });

  it("splits camelCase and snake_case alike, so bare names still get a fair read", async () => {
    const bare = bareCatalog([REFUND, LOOKUP]);
    // 'postRefunds' only routes if camelCase splits into post + refunds.
    expect(await lexicalRouter().route("post a refund", bare)).toBe("postRefunds");
  });
});

describe("the agent router seam", () => {
  const catalog = curatedCatalog([REFUND, LOOKUP]);
  const runner = (stdout: string, exitCode = 0): AgentProcessRunner => ({
    run: () =>
      Promise.resolve({
        stdout,
        stderr: "",
        exitCode,
        signal: null,
        startedAt: "2026-08-28T00:00:00Z",
        endedAt: "2026-08-28T00:00:01Z",
        durationMs: 1000,
        timedOut: false,
        canceled: false,
      }),
  });

  it("routes to the tool the model names, when the name is in the catalog", async () => {
    const router = agentRouter(runner('{"tool": "payments_get_payment"}'), "model");
    expect(await router.route("find my payment", catalog)).toBe("payments_get_payment");
  });

  it("refuses a name the model invented — a hallucinated tool is a failed route", async () => {
    const router = agentRouter(runner('{"tool": "payments_delete_everything"}'), "model");
    expect(await router.route("find my payment", catalog)).toBeUndefined();
  });

  it("reads the fenced JSON real model CLIs actually print", async () => {
    // Regression: the first version demanded that stdout parse as JSON whole,
    // and scored 0/20 against a real model that had routed every task
    // correctly — it fenced its answers. The measurement was wrong, not the
    // model.
    const fenced = agentRouter(runner('```json\n{"tool": "payments_get_payment"}\n```'), "model");
    expect(await fenced.route("find my payment", catalog)).toBe("payments_get_payment");

    const bare = agentRouter(runner('```\n{"tool": "payments_get_payment"}\n```'), "model");
    expect(await bare.route("find my payment", catalog)).toBe("payments_get_payment");

    const chatty = agentRouter(
      runner(
        'Looking at the catalog, the best fit is:\n{"tool": "payments_get_payment"}\nHope that helps!',
      ),
      "model",
    );
    expect(await chatty.route("find my payment", catalog)).toBe("payments_get_payment");
  });

  it("extracts nothing from output that names no tool object", () => {
    expect(extractRoutedTool("")).toBeUndefined();
    expect(extractRoutedTool("I think you want get_payment")).toBeUndefined();
    expect(extractRoutedTool('{"choice": "payments_get_payment"}')).toBeUndefined();
    expect(extractRoutedTool('{"tool": ""}')).toBeUndefined();
    expect(extractRoutedTool('{"tool": 7}')).toBeUndefined();
  });

  it("keeps the catalog gate strict even when the syntax is loose", async () => {
    // Tolerance is about how the answer is written, never about which tools
    // exist: a fenced hallucination is still a hallucination.
    const router = agentRouter(
      runner('```json\n{"tool": "payments_delete_everything"}\n```'),
      "model",
    );
    expect(await router.route("find my payment", catalog)).toBeUndefined();
  });

  it("fails closed on a non-zero exit and on unparseable output", async () => {
    expect(
      await agentRouter(runner("", 1), "model").route("find my payment", catalog),
    ).toBeUndefined();
    expect(
      await agentRouter(runner("I think you want get_payment"), "model").route(
        "find my payment",
        catalog,
      ),
    ).toBeUndefined();
  });
});

describe("scoring", () => {
  it("passes only when the routed tool is the intent's own operation", async () => {
    const catalog = curatedCatalog([REFUND, LOOKUP]);
    const right = await routeAndScore(lexicalRouter(), "refund the payment", catalog, REFUND.id);
    expect(right.pass).toBe(true);
    const wrong = await routeAndScore(lexicalRouter(), "refund the payment", catalog, LOOKUP.id);
    expect(wrong.routed).toBe("payments_create_refund");
    expect(wrong.pass).toBe(false);
  });

  it("benchmarks only the exposed surface: approved, and never a webhook receiver", () => {
    const air = {
      operations: [
        REFUND,
        op({ id: "payments.pending.get", state: "review_required" }),
        op({ id: "payments.hook.receive", archetype: "webhook_receiver" }),
      ],
    } as unknown as Parameters<typeof benchmarkOperations>[0];
    expect(benchmarkOperations(air).map((o) => o.id)).toEqual([REFUND.id]);
  });
});
