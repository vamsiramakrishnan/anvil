import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ObserveConfig, type ObserveReport, runObserve } from "./observe.js";

/**
 * The observed-reality lane, against an application that has drifted from its
 * own published contract — which is the normal state of a long-lived service,
 * not an exotic one.
 *
 * The fake app below is a stand-in for a Spring Boot service with springdoc:
 * it publishes an OpenAPI document at `/v3/api-docs`, and it does three things
 * that every hermetic lane in this repository is structurally unable to notice.
 *
 *   1. Its published contract has moved on from the one the bundle compiled.
 *   2. A read returns fields the compiled contract never declared.
 *   3. An operation the compiled contract declares is simply not served.
 *
 * A bundle can be perfectly faithful to AIR and still be wrong about all three.
 */

/** What the bundle was compiled from — the spec as it was six months ago. */
const COMPILED_SPEC = `openapi: 3.0.3
info: { title: Widgets, version: 1.0.0 }
servers:
  - url: http://127.0.0.1:1
paths:
  /widgets/{widget_id}:
    get:
      operationId: getWidget
      tags: [widgets]
      parameters:
        - { name: widget_id, in: path, required: true, schema: { type: string } }
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
                  name: { type: string }
  /widgets/{widget_id}/audit:
    get:
      operationId: getWidgetAudit
      tags: [widgets]
      parameters:
        - { name: widget_id, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
  /widgets:
    post:
      operationId: createWidget
      tags: [widgets]
      responses: { "201": { description: created } }
`;

/**
 * What the application publishes about itself today: `getWidget` gained a
 * required query parameter, and the audit endpoint is gone.
 */
const PUBLISHED_SPEC = {
  openapi: "3.0.3",
  info: { title: "Widgets", version: "2.0.0" },
  paths: {
    "/widgets/{widget_id}": {
      get: {
        operationId: "getWidget",
        tags: ["widgets"],
        parameters: [
          { name: "widget_id", in: "path", required: true, schema: { type: "string" } },
          { name: "tenant", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
    "/widgets": {
      post: {
        operationId: "createWidget",
        tags: ["widgets"],
        responses: { "201": { description: "created" } },
      },
    },
  },
};

const MANIFEST = `operations:
  getWidget: { state: approved }
  getWidgetAudit: { state: approved }
  createWidget:
    state: approved
    idempotency: { mode: natural }
`;

let bundleDir: string;
let app: Server;
let baseUrl: string;
/** Every path the application was actually asked for, in order. */
const requested: string[] = [];

beforeAll(async () => {
  const air = await compile({ spec: COMPILED_SPEC, manifest: MANIFEST, serviceId: "widgets" });
  bundleDir = mkdtempSync(join(tmpdir(), "anvil-observe-"));
  writeBundle(bundleDir, generateBundle(air));

  app = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? "";
    requested.push(`${request.method} ${url.split("?")[0]}`);
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.startsWith("/v3/api-docs")) return send(200, PUBLISHED_SPEC);
    if (/^\/widgets\/[^/]+\/audit/.test(url)) {
      // Retired two releases ago. The compiled contract still declares it.
      return send(404, { error: "no such endpoint" });
    }
    if (/^\/widgets\/[^/]+/.test(url)) {
      // Returns more than the compiled contract ever declared.
      return send(200, { id: "w1", name: "Widget", tenant: "acme", archived: false });
    }
    return send(404, { error: "not found" });
  });
  await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
  const address = app.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}, 120_000);

afterAll(() => {
  app?.close();
  if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
});

async function observe(overrides: Partial<ObserveConfig> = {}): Promise<ObserveReport> {
  return runObserve(
    bundleDir,
    ObserveConfig.parse({
      baseUrl,
      contractPath: "/v3/api-docs",
      probeReads: ["widgets.widgets.get", "widgets.audit.list"],
      inputs: {
        "widgets.widgets.get": { widget_id: "w1" },
        "widgets.audit.list": { widget_id: "w1" },
      },
      ...overrides,
    }),
  );
}

describe("observing a running application", () => {
  let report: ObserveReport;

  beforeAll(async () => {
    report = await observe();
  }, 180_000);

  it("reads the contract the application publishes about itself, and binds it to bytes", () => {
    expect(report.contract.attempted).toBe(true);
    expect(report.contract.ok, report.contract.detail).toBe(true);
    expect(report.contract.url).toContain("/v3/api-docs");
    // The digest is what makes a drift finding auditable later: it names the
    // exact bytes the application served at observation time.
    expect(report.contract.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports the application's contract disagreeing with the compiled one", () => {
    expect(report.drift.length).toBeGreaterThan(0);
    const kinds = new Set(report.drift.map((item) => item.kind));
    // The audit endpoint is gone from the published contract entirely.
    expect(kinds.has("operation_removed")).toBe(true);
  });

  it("catches a read returning fields the contract never declared", () => {
    const observation = report.observations.find((o) => o.operationId === "widgets.widgets.get");
    expect(observation?.outcome).toBe("ok");
    // `tenant` and `archived` are real response fields no agent could know about
    // from the compiled contract — the exact blindness this lane exists for.
    expect(observation?.undeclaredFields).toEqual(["archived", "tenant"]);
    expect(observation?.declaredFields).toEqual(["id", "name"]);
  });

  it("catches a declared operation the application does not serve", () => {
    const observation = report.observations.find((o) => o.operationId === "widgets.audit.list");
    expect(observation?.outcome).toBe("unreachable");
    expect(observation?.errorCode).toBe("not_found");
  });

  it("proposes deprecating only the operation the application says is gone", () => {
    expect(report.proposal).toBeDefined();
    const operations = report.proposal?.operations ?? {};
    expect(Object.keys(operations)).toEqual(["widgets.audit.list"]);
    expect(operations["widgets.audit.list"]?.state).toBe("deprecated");
  });

  it("proposes nothing about the operation that merely answered", () => {
    // A successful read proves the endpoint exists and what it returned. It
    // proves nothing about idempotency or confirmation, and recorded traffic's
    // high reliability must not be allowed to launder an unrelated loosening.
    const operations = report.proposal?.operations ?? {};
    expect(operations["widgets.widgets.get"]).toBeUndefined();
  });

  it("fails the lane when the application contradicts the contract", () => {
    expect(report.ok).toBe(false);
    expect(report.summary.unreachable).toBe(1);
    expect(report.summary.probed).toBe(2);
  });
});

describe("the lane never drives a mutation", () => {
  it("refuses a mutation named in probeReads instead of silently skipping it", async () => {
    const before = requested.length;
    const report = await observe({
      probeReads: ["widgets.widgets.create"],
      inputs: {},
    });
    const refusal = report.observations.find((o) => o.operationId === "widgets.widgets.create");
    expect(refusal?.outcome).toBe("refused");
    expect(refusal?.detail).toContain("never drives a mutation");
    // An operator who lists a mutation believes it is being exercised. Refusing
    // loudly and failing the lane is the only honest answer.
    expect(report.ok).toBe(false);

    // The load-bearing assertion, and the one an earlier draft got wrong: the
    // lane must not DRIVE it, which is not the same as no POST arriving. The
    // runtime's own confirmation gate also refuses an unconfirmed mutation
    // before the wire, so asserting only on what reached the application proved
    // the runtime's gate while leaving this lane's gate untested — the mutation
    // gate caught exactly that (`observe/read-only-probe`).
    expect(report.summary.probed).toBe(0);
    expect(report.observations).toHaveLength(1);
    // Belt and braces: nothing reached the application either.
    expect(requested.slice(before).filter((entry) => entry.startsWith("POST"))).toEqual([]);
  }, 180_000);
});

describe("re-capturing what the application served", () => {
  it("hands back the exact bytes and digest, without ingesting them itself", async () => {
    let seen: { text: string; url: string; sha256: string } | undefined;
    const report = await runObserve(
      bundleDir,
      ObserveConfig.parse({ baseUrl, contractPath: "/v3/api-docs", probeReads: [], inputs: {} }),
      {
        onContract: (contract) => {
          seen = contract;
        },
      },
    );
    expect(seen).toBeDefined();
    // The same digest the report binds its drift finding to — so a spec saved
    // now and compiled later is provably the one that produced these findings.
    expect(seen?.sha256).toBe(report.contract.sha256);
    expect(JSON.parse(seen?.text ?? "null")).toEqual(PUBLISHED_SPEC);
  }, 120_000);
});

describe("an application that publishes no contract", () => {
  it("says so plainly rather than treating it as a failure to acquire", async () => {
    const report = await observe({ contractPath: undefined, probeReads: [], inputs: {} });
    expect(report.contract.attempted).toBe(false);
    expect(report.contract.detail).toContain("not asked");
    expect(report.drift).toEqual([]);
  }, 120_000);
});
