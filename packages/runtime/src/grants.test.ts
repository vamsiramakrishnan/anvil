import { Operation } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { decideGrant, globMatches, grantOperationNames, parseGrants } from "./grants.js";

function op(id: string, kind: "read" | "mutation", confirm = false): Operation {
  return Operation.parse({
    id,
    canonicalName: id.replace(/\./g, "_"),
    displayName: id,
    sourceRef: { kind: "openapi", path: "/x", method: kind === "read" ? "get" : "post" },
    effect: {
      kind,
      action: kind === "read" ? "list" : "create",
      resource: "issue",
      risk: kind === "read" ? "low" : "medium",
      reversible: false,
    },
    input: { params: [] },
    idempotency: { mode: kind === "read" ? "natural" : "none", mechanism: "none" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: confirm },
    auth: { type: "none", scopes: [] },
    cli: { command: `svc ${id}` },
    mcp: { toolName: id.replace(/\./g, "_") },
    skill: { intentExamples: [] },
    state: "approved",
  });
}

const list = op("github.issues.list", "read");
const create = op("github.issues.create", "mutation", true);
const label = op("github.labels.create", "mutation", false);

describe("parseGrants", () => {
  it("accepts the contract's entry shape and keeps only known keys", () => {
    expect(
      parseGrants([
        {
          connector: "github",
          operations: ["issues.*", "pulls.list"],
          mode: "read",
          account: "work",
          extra: "ignored",
        },
        { connector: "github", operations: ["*"], mode: "write", confirm: "allow" },
      ]),
    ).toEqual([
      {
        connector: "github",
        operations: ["issues.*", "pulls.list"],
        mode: "read",
        account: "work",
      },
      { connector: "github", operations: ["*"], mode: "write", confirm: "allow" },
    ]);
    expect(parseGrants([])).toEqual([]);
  });

  it.each([
    ["not a list", { connector: "github" }],
    ["entry not an object", ["github"]],
    ["missing connector", [{ operations: ["*"], mode: "read" }]],
    ["bad connector", [{ connector: "git hub", operations: ["*"], mode: "read" }]],
    ["empty operations", [{ connector: "github", operations: [], mode: "read" }]],
    ["non-string glob", [{ connector: "github", operations: [1], mode: "read" }]],
    ["unknown mode", [{ connector: "github", operations: ["*"], mode: "admin" }]],
    ["bad account", [{ connector: "github", operations: ["*"], mode: "read", account: "a b" }]],
    ["bad confirm", [{ connector: "github", operations: ["*"], mode: "write", confirm: true }]],
  ])("refuses a malformed grant (%s) as a whole", (_label, raw) => {
    expect(parseGrants(raw)).toBeUndefined();
  });
});

describe("globMatches", () => {
  it("matches * across dots and ? as one character, everything else literally", () => {
    expect(globMatches("*", "github.issues.list")).toBe(true);
    expect(globMatches("issues.*", "issues.list")).toBe(true);
    expect(globMatches("issues.*", "pulls.list")).toBe(false);
    expect(globMatches("issues.lis?", "issues.list")).toBe(true);
    expect(globMatches("issues.list", "issuesXlist")).toBe(false);
    expect(globMatches("a+b", "aab")).toBe(false);
  });

  it("matches with or without the service prefix", () => {
    expect(grantOperationNames(list, "github")).toEqual(["github.issues.list", "issues.list"]);
    expect(grantOperationNames(list, "other")).toEqual(["github.issues.list"]);
  });
});

describe("decideGrant", () => {
  it("allows a read under a read entry and selects its account", () => {
    const decision = decideGrant(
      [{ connector: "github", operations: ["issues.*"], mode: "read", account: "work" }],
      "github",
      list,
      "github",
    );
    expect(decision).toMatchObject({ allowed: true, index: 0, account: "work" });
  });

  it("uses the default account when the entry names none", () => {
    const decision = decideGrant(
      [{ connector: "github", operations: ["*"], mode: "read" }],
      "github",
      list,
      "github",
    );
    expect(decision).toMatchObject({ allowed: true, account: "default" });
  });

  it("denies a connector the grant does not name", () => {
    const decision = decideGrant(
      [{ connector: "slack", operations: ["*"], mode: "write" }],
      "github",
      list,
      "github",
    );
    expect(decision).toMatchObject({ allowed: false, decision: "denied" });
    expect(decision.allowed ? "" : decision.reason).toContain("no entry for connector 'github'");
  });

  it("denies an operation no glob names", () => {
    const decision = decideGrant(
      [{ connector: "github", operations: ["pulls.list"], mode: "write" }],
      "github",
      list,
      "github",
    );
    expect(decision).toMatchObject({ allowed: false, decision: "denied" });
    expect(decision.allowed ? "" : decision.reason).toContain(
      "names operation 'github.issues.list'",
    );
  });

  it("denies a mutation under read-only entries and names the entry", () => {
    const decision = decideGrant(
      [{ connector: "github", operations: ["*"], mode: "read" }],
      "github",
      label,
      "github",
    );
    expect(decision).toMatchObject({
      allowed: false,
      decision: "denied",
      index: 0,
      entry: { mode: "read" },
    });
    expect(decision.allowed ? "" : decision.reason).toContain("read-only");
  });

  it("allows a mutation without confirmation under a write entry", () => {
    expect(
      decideGrant(
        [{ connector: "github", operations: ["*"], mode: "write" }],
        "github",
        label,
        "github",
      ),
    ).toMatchObject({ allowed: true });
  });

  it("refuses a confirmation-gated mutation unless the entry says confirm: allow", () => {
    const without = decideGrant(
      [{ connector: "github", operations: ["*"], mode: "write" }],
      "github",
      create,
      "github",
    );
    expect(without).toMatchObject({ allowed: false, decision: "confirmation_required", index: 0 });
    const withAllow = decideGrant(
      [
        { connector: "github", operations: ["*"], mode: "write" },
        { connector: "github", operations: ["issues.create"], mode: "write", confirm: "allow" },
      ],
      "github",
      create,
      "github",
    );
    expect(withAllow).toMatchObject({ allowed: true, index: 1 });
  });

  it("an empty grant allows nothing", () => {
    expect(decideGrant([], "github", list, "github")).toMatchObject({ allowed: false });
  });
});
