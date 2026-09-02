import { describe, expect, it } from "vitest";
import { fixtureWorkspace } from "./dev/fixtures.js";
import {
  bulkBarrier,
  type DecisionRow,
  href,
  initialTheme,
  POLICIES,
  type Policy,
  parseHash,
  REDACTED,
  redact,
  rowKey,
  selectByPolicy,
  toRows,
} from "./model.js";

/**
 * The bulk-policy invariant: no policy — present or future — can select a
 * non-idempotent or destructive row, because `selectByPolicy` filters through
 * `bulkBarrier` before any predicate runs. Every field the barrier reads is on
 * the item's own `subject`; nothing here joins against another view.
 */

function rows() {
  const { payments } = fixtureWorkspace().bundles;
  if (!payments) throw new Error("fixture has no payments bundle");
  return toRows(payments.queue);
}

function packRow(all: DecisionRow[], id: string): Extract<DecisionRow, { kind: "pack" }> {
  const row = all.find((r) => r.kind === "pack" && r.id === id);
  if (row?.kind !== "pack") throw new Error(`no pack row ${id}`);
  return row;
}

describe("bulk policies", () => {
  const all = rows();

  it("never select a non-idempotent mutation, a destructive one, or a blocked operation", () => {
    const forbidden = all.filter(
      (row) =>
        row.kind === "operation" &&
        (row.subject.idempotency.mode === "none" ||
          row.subject.effect.risk === "destructive" ||
          row.subject.effect.action === "delete" ||
          row.blocking),
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

  it("says why each barred row is barred, reading the subject alone", () => {
    const byId = new Map(all.map((row) => [row.id, row]));
    expect(bulkBarrier(byId.get("sendReceipt") as never)).toMatch(/non-idempotent/);
    expect(bulkBarrier(byId.get("deletePaymentMethod") as never)).toMatch(/destructive/);
    expect(bulkBarrier(byId.get("createRefund") as never)).toMatch(/irreversible/);
    expect(bulkBarrier(byId.get("exportStatement") as never)).toMatch(/blocked/);
    expect(bulkBarrier(byId.get("reconcile_statement") as never)).toMatch(/no approve route/);
    expect(bulkBarrier(byId.get("cluster_payment_lookup") as never)).toMatch(/exported/);
    // A pack row the receipt binding would refuse, or whose measured delta is
    // not positive, is barred even if a server ever listed it.
    const lookup = packRow(all, "rf_group_lookup_payment");
    expect(bulkBarrier(lookup)).toBeUndefined();
    expect(bulkBarrier({ ...lookup, subject: { ...lookup.subject, tier: "reject" } })).toMatch(
      /tier reject/,
    );
    const delta = lookup.subject.delta;
    if (!delta) throw new Error("fixture delta missing");
    expect(
      bulkBarrier({
        ...lookup,
        subject: { ...lookup.subject, delta: { ...delta, upliftPts: -12.5 } },
      }),
    ).toMatch(/never bulk-approved/);
  });

  it("keeps a policy inside the un-barred set whatever its predicate claims", () => {
    // The shipped policies are narrow; the barrier is what stops the next one
    // from being wide. A policy that selects everything still gets nothing barred.
    const everything: Policy = { id: "everything", label: "everything", selects: () => true };
    const chosen = selectByPolicy(all, everything);
    expect(chosen.length).toBeGreaterThan(0);
    expect(chosen.length).toBeLessThan(all.length);
    for (const row of chosen) expect(bulkBarrier(row), row.key).toBeUndefined();
    const ids = chosen.map((row) => row.id);
    for (const barred of [
      "sendReceipt",
      "deletePaymentMethod",
      "createRefund",
      "exportStatement",
      "everything",
      "reconcile_statement",
      "cluster_payment_lookup",
    ]) {
      expect(ids, barred).not.toContain(barred);
    }
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

  it("carries packs awaiting a receipt and benchmark clusters as their own kinds, from the server", () => {
    // The regressed, tier-reject refinement is not a decision: no receipt can bind it.
    expect(all.filter((row) => row.kind === "pack").map((row) => row.id)).toEqual([
      "rf_describe_sendReceipt",
      "rf_group_lookup_payment",
    ]);
    expect(all.filter((row) => row.kind === "cluster").length).toBe(2);
  });

  it("keys every row uniquely, a pack row on its pack as well as its refinement", () => {
    expect(new Set(all.map((row) => row.key)).size).toBe(all.length);
    const lookup = packRow(all, "rf_group_lookup_payment");
    expect(rowKey(lookup)).toBe(`pack:${lookup.subject.packHash}:rf_group_lookup_payment`);
    expect(rowKey(all[0] as DecisionRow)).toBe(`${all[0]?.kind}:${all[0]?.id}`);
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
