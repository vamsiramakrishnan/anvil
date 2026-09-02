import { describe, expect, it } from "vitest";
import { fixtureWorkspace } from "./dev/fixtures.js";
import {
  buildRows,
  bulkBarrier,
  href,
  initialTheme,
  POLICIES,
  parseHash,
  REDACTED,
  redact,
  selectByPolicy,
} from "./model.js";

/**
 * The bulk-policy invariant: no policy — present or future — can select a
 * non-idempotent or destructive row, because `selectByPolicy` filters through
 * `bulkBarrier` before any predicate runs.
 */

function rows() {
  const { payments } = fixtureWorkspace().bundles;
  if (!payments) throw new Error("fixture has no payments bundle");
  return buildRows(payments.queue, payments.inspector, payments.packs, payments.benchmark);
}

describe("bulk policies", () => {
  const all = rows();

  it("never select a non-idempotent mutation, a destructive one, or a blocked operation", () => {
    const forbidden = all.filter(
      (row) =>
        row.kind === "operation" &&
        (row.op?.idempotency.mode === "none" ||
          row.op?.effect.risk === "destructive" ||
          row.op?.effect.action === "delete" ||
          row.op?.state === "blocked"),
    );
    expect(forbidden.map((row) => row.id).sort()).toEqual([
      "deletePaymentMethod",
      "exportStatement",
      "sendReceipt",
    ]);
    for (const policy of POLICIES) {
      const chosen = selectByPolicy(all, policy).map((row) => row.key);
      for (const row of forbidden) expect(chosen, policy.id).not.toContain(row.key);
      for (const key of chosen) {
        const row = all.find((r) => r.key === key);
        expect(
          row && bulkBarrier(row),
          `${policy.id} selected a barred row ${key}`,
        ).toBeUndefined();
      }
    }
  });

  it("says why each barred row is barred", () => {
    const byId = new Map(all.map((row) => [row.id, row]));
    expect(bulkBarrier(byId.get("sendReceipt") as never)).toMatch(/non-idempotent/);
    expect(bulkBarrier(byId.get("deletePaymentMethod") as never)).toMatch(/destructive/);
    expect(bulkBarrier(byId.get("createRefund") as never)).toMatch(/irreversible/);
    expect(bulkBarrier(byId.get("exportStatement") as never)).toMatch(/blocked/);
    expect(bulkBarrier(byId.get("rf_group_money_moves") as never)).toMatch(/tier reject/);
    expect(bulkBarrier(byId.get("reconcile_statement") as never)).toMatch(/no approve route/);
  });

  it("'safe reads' selects exactly the evidence-backed naturally idempotent reads", () => {
    const policy = POLICIES.find((p) => p.id === "safe-reads");
    if (!policy) throw new Error("policy missing");
    expect(
      selectByPolicy(all, policy)
        .map((row) => row.id)
        .sort(),
    ).toEqual(["listPayments", "searchPayments"]);
  });

  it("'positive delta' selects only pack refinements whose measured uplift is positive", () => {
    const policy = POLICIES.find((p) => p.id === "positive-delta");
    if (!policy) throw new Error("policy missing");
    expect(selectByPolicy(all, policy).map((row) => row.id)).toEqual(["rf_group_lookup_payment"]);
  });

  it("'within budget' selects only capabilities whose verdict is ok", () => {
    const policy = POLICIES.find((p) => p.id === "budget-ok");
    if (!policy) throw new Error("policy missing");
    expect(selectByPolicy(all, policy).map((row) => row.id)).toEqual(["customers"]);
  });

  it("joins packs and clusters into the queue as their own kinds", () => {
    expect(all.filter((row) => row.kind === "pack").length).toBe(3);
    expect(all.filter((row) => row.kind === "cluster").length).toBe(2);
  });
});

describe("redaction", () => {
  it("replaces every value stored under a secret-like key, at any depth", () => {
    const out = redact({
      a: { token: "t", nested: [{ clientSecret: "s", ok: 1 }] },
      Authorization: "Bearer x",
      password: "p",
      tokenEndpoint: "https://x",
      keep: "visible",
    }) as Record<string, unknown>;
    expect(out).toEqual({
      a: { token: REDACTED, nested: [{ clientSecret: REDACTED, ok: 1 }] },
      Authorization: REDACTED,
      password: REDACTED,
      tokenEndpoint: REDACTED,
      keep: "visible",
    });
  });
});

describe("routing and theme", () => {
  it("parses the hash routes and round-trips href", () => {
    expect(parseHash("")).toEqual({ view: "workspace" });
    expect(parseHash("#/")).toEqual({ view: "workspace" });
    const route = parseHash(href("pay ments", "inspect", { against: "b2" }));
    expect(route.view).toBe("inspect");
    if (route.view === "workspace") throw new Error("unreachable");
    expect(route.bundleId).toBe("pay ments");
    expect(route.query.get("against")).toBe("b2");
    expect(parseHash("#/b/x/nope")).toEqual({ view: "workspace" });
  });

  it("defaults the theme to the system preference and honours a stored choice", () => {
    expect(initialTheme(undefined, true)).toBe("dark");
    expect(initialTheme(undefined, false)).toBe("light");
    expect(initialTheme({ getItem: () => "light" }, true)).toBe("light");
    expect(initialTheme({ getItem: () => "garbage" }, true)).toBe("dark");
  });
});
