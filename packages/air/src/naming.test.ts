import { describe, expect, it } from "vitest";
import { isQueryPassthroughParam } from "./naming.js";

describe("isQueryPassthroughParam", () => {
  it("fires on unambiguous query-language names in any location", () => {
    for (const name of ["sql", "jql", "cql", "kql", "xpath", "dsl", "where", "expression"]) {
      expect(isQueryPassthroughParam(name, { type: "string" }, "param"), `${name} param`).toBe(
        true,
      );
      expect(isQueryPassthroughParam(name, { type: "string" }, "body"), `${name} body`).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(isQueryPassthroughParam("SQL", { type: "string" }, "param")).toBe(true);
    expect(isQueryPassthroughParam("JQL", { type: "string" }, "body")).toBe(true);
  });

  it("treats q/query/filter as search data in a query string but a query document in a body", () => {
    // `GET /search?q=coffee` is free text, not logic — blocking it would make
    // every ordinary search API compile to blocked.
    for (const name of ["q", "query", "filter"]) {
      expect(isQueryPassthroughParam(name, { type: "string" }, "param"), `${name} param`).toBe(
        false,
      );
      expect(isQueryPassthroughParam(name, { type: "string" }, "body"), `${name} body`).toBe(true);
    }
  });

  it("does not fire when the schema is constrained", () => {
    expect(
      isQueryPassthroughParam("sql", { type: "string", enum: ["daily", "weekly"] }, "param"),
    ).toBe(false);
    expect(isQueryPassthroughParam("sql", { type: "string", maxLength: 100 }, "body")).toBe(false);
    expect(isQueryPassthroughParam("query", { type: "string", pattern: "^[a-z]+$" }, "body")).toBe(
      false,
    );
  });

  it("does not fire on non-string types", () => {
    expect(isQueryPassthroughParam("sql", { type: "integer" }, "param")).toBe(false);
    expect(isQueryPassthroughParam("query", { type: "object" }, "body")).toBe(false);
  });

  it("does not fire on non-matching names", () => {
    expect(isQueryPassthroughParam("statement", { type: "string" }, "body")).toBe(false);
    expect(isQueryPassthroughParam("sqlText", { type: "string" }, "body")).toBe(false);
    expect(isQueryPassthroughParam("q_value", { type: "string" }, "body")).toBe(false);
  });

  it("does not fire without a schema", () => {
    expect(isQueryPassthroughParam("sql", undefined, "param")).toBe(false);
  });
});
