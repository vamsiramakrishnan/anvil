// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createConsoleApi } from "./api.js";
import { App } from "./app.js";
import { fixtureWorkspace } from "./dev/fixtures.js";
import { createMockConsole, mockFetch } from "./dev/mock-server.js";
import { SECRET_KEY } from "./model.js";

/**
 * No value stored under a field named like token/secret/password/authorization
 * is ever rendered, from any record, on any view — even when the contract
 * hands it over inside an `unknown` (a claim value, drift facts).
 */

const SENTINELS = {
  tokenEndpoint: "https://SENTINEL-TOKEN-ENDPOINT.invalid/oauth/token",
  claimToken: "SENTINEL-CLAIM-TOKEN-VALUE",
  claimPassword: "SENTINEL-CLAIM-PASSWORD",
  driftAuthorization: "SENTINEL-DRIFT-AUTHORIZATION",
  packSecret: "SENTINEL-PACK-CLIENT-SECRET",
  visibleSibling: "SENTINEL-VISIBLE-SIBLING",
};

function seededWorkspace() {
  const state = fixtureWorkspace();
  const payments = state.bundles.payments;
  if (!payments) throw new Error("fixture");
  const provider = payments.inspector.service.auth.provider;
  if (!provider) throw new Error("fixture has no auth provider");
  provider.tokenEndpoint = SENTINELS.tokenEndpoint;
  const item = payments.queue.items.find((i) => i.id === "listPayments");
  if (!item) throw new Error("fixture");
  item.evidence.push({
    subject: "listPayments",
    predicate: "auth.material",
    value: {
      token: SENTINELS.claimToken,
      password: SENTINELS.claimPassword,
      visible: SENTINELS.visibleSibling,
    },
    source: "recorded_traffic",
    confidence: 0.9,
  });
  const drift = payments.drift["payments-next"]?.items[0];
  if (!drift) throw new Error("fixture");
  drift.facts = { ...drift.facts, authorization: SENTINELS.driftAuthorization };
  const pack = payments.packs[0]?.items[0];
  if (!pack) throw new Error("fixture");
  pack.claims.push({
    subject: "sendReceipt",
    predicate: "auth",
    value: { clientSecret: SENTINELS.packSecret },
    source: "source_impl",
    confidence: 0.8,
  });
  return state;
}

/** Every string stored under a secret-like key anywhere in the fixture. */
function secretValues(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) secretValues(v, out);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key) && typeof child === "string" && child.length >= 8) out.add(child);
      secretValues(child, out);
    }
  }
  return out;
}

afterEach(() => {
  cleanup();
  location.hash = "";
});

const VIEWS = [
  "#/",
  "#/b/payments/queue",
  "#/b/payments/inspect?against=payments-next",
  "#/b/payments/confusion",
];

describe("redaction", () => {
  it("the seeded fixture really carries the secrets (so the assertion means something)", () => {
    const secrets = secretValues(seededWorkspace());
    for (const value of Object.values(SENTINELS)) {
      if (value === SENTINELS.visibleSibling) continue;
      expect([...secrets]).toContain(value);
    }
  });

  for (const hash of VIEWS) {
    it(`renders no secret-like field on ${hash}`, async () => {
      const state = seededWorkspace();
      const mock = createMockConsole(state);
      location.hash = hash;
      render(<App api={createConsoleApi({ fetch: mockFetch(mock), token: () => mock.token })} />);
      // Settle: every view shows its heading once its read models have loaded.
      await screen.findByRole("heading", { level: 1 });
      if (hash.includes("queue")) await screen.findByLabelText("select listPayments");
      if (hash.includes("inspect")) await screen.findByText(/idempotency mode changed/);
      if (hash.includes("confusion")) await screen.findByRole("img");
      const text = document.body.textContent ?? "";
      for (const secret of secretValues(state)) expect(text, secret).not.toContain(secret);
      expect(text).not.toContain("SENTINEL-TOKEN-ENDPOINT");
    });
  }

  it("renders the non-secret sibling of a redacted claim value, marking the secret as redacted", async () => {
    const state = seededWorkspace();
    const mock = createMockConsole(state);
    location.hash = "#/b/payments/queue";
    render(<App api={createConsoleApi({ fetch: mockFetch(mock), token: () => mock.token })} />);
    await screen.findByLabelText("select listPayments");
    const text = document.body.textContent ?? "";
    expect(text).toContain(SENTINELS.visibleSibling);
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(SENTINELS.claimToken);
  });
});
