import { type BusinessPlan, loadBusinessPlan } from "@anvil/air";
import { type BusinessHost, executeBusiness } from "./business.js";
import type { HttpRequest, HttpResponse, Transport } from "./transport.js";

/** HTTP contract shared by the gateway route and its in-process MCP transport. */
export class BusinessTransport implements Transport {
  private readonly plan: BusinessPlan;
  constructor(
    plan: BusinessPlan,
    private readonly host: BusinessHost,
  ) {
    this.plan = loadBusinessPlan(plan);
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const reply = (status: number, value: unknown): HttpResponse => ({
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    const path = new URL(request.url).pathname;
    const action = this.plan.definition.actions.find(
      (a) => path === `/business/${a.id}` && a.state === "approved",
    );
    if (request.method !== "POST" || !action)
      return reply(404, { error: "Unknown business action." });
    if (Buffer.byteLength(request.body ?? "", "utf8") > 1_048_576)
      return reply(413, { error: "Business input exceeds the size limit." });
    let input: unknown;
    try {
      input = JSON.parse(request.body ?? "");
    } catch {
      return reply(400, { error: "Expected a JSON object." });
    }
    if (!input || typeof input !== "object" || Array.isArray(input))
      return reply(400, { error: "Expected a JSON object." });
    const key = Object.entries(request.headers).find(
      ([name]) => name.toLowerCase() === "idempotency-key",
    )?.[1];
    return reply(
      200,
      await executeBusiness(this.plan, action.id, input as Record<string, unknown>, this.host, key),
    );
  }
}
