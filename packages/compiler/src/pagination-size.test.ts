import { Pagination } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { classifyEffect, classifyPagination } from "./classify.js";

/**
 * Page-SIZE inference, tested against the shapes it will actually meet.
 *
 * The size param is the only knob that lets a serving surface ask for less
 * instead of fetching everything and cutting it afterwards, so these cases are
 * drawn from real specs rather than invented: GitHub `per_page`, Jira
 * `maxResults`, Stripe `limit`, OData `$top`, Slack `cursor`+`limit`. The
 * negative cases matter at least as much — a false positive means a surface
 * silently rewrites a domain parameter, which is worse than an unset field.
 */

const param = (name: string, schema: Record<string, unknown> = { type: "string" }) => ({
  name,
  in: "query" as const,
  required: false,
  schema,
  inferred: false,
});

const listRead = classifyEffect("get", "listThings /things");
const paginate = (params: ReturnType<typeof param>[], out?: Record<string, unknown>) =>
  classifyPagination(listRead.effect, listRead.effect.action, params, out);

describe("classifyPagination — page size detection", () => {
  it("reads GitHub's page/per_page pair including its declared cap and default", () => {
    // GET /repos/{owner}/{repo}/issues returns a bare array, so there is no
    // items/next field to ground — the size fields must stand on their own.
    expect(
      paginate([
        param("page", { type: "integer", default: 1 }),
        param("per_page", { type: "integer", default: 30, maximum: 100 }),
      ]),
    ).toEqual({
      style: "page",
      cursorParam: "page",
      pageSizeParam: "per_page",
      maxPageSize: 100,
      defaultPageSize: 30,
    });
  });

  it("reads Jira's startAt/maxResults pair and keeps the wire casing", () => {
    const out = {
      type: "object",
      properties: {
        issues: { type: "array" },
        startAt: { type: "integer" },
        maxResults: { type: "integer" },
        total: { type: "integer" },
      },
    };
    // `maxResults` — not `maxresults`: the surface has to send the name the
    // upstream declared, so normalization is for matching only.
    expect(
      paginate(
        [
          param("startAt", { type: "integer" }),
          param("maxResults", { type: "integer", default: 50, maximum: 100 }),
        ],
        out,
      ),
    ).toEqual({
      style: "offset",
      cursorParam: "startAt",
      itemsField: "issues",
      pageSizeParam: "maxResults",
      maxPageSize: 100,
      defaultPageSize: 50,
    });
  });

  it("reads Stripe's starting_after/limit pair", () => {
    const out = {
      type: "object",
      properties: {
        object: { type: "string" },
        data: { type: "array" },
        has_more: { type: "boolean" },
      },
    };
    expect(
      paginate(
        [param("starting_after"), param("limit", { type: "integer", default: 10, maximum: 100 })],
        out,
      ),
    ).toEqual({
      style: "cursor",
      cursorParam: "starting_after",
      itemsField: "data",
      pageSizeParam: "limit",
      maxPageSize: 100,
      defaultPageSize: 10,
    });
  });

  it("reads Slack's cursor/limit pair and its nested next_cursor", () => {
    const out = {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        channels: { type: "array" },
        response_metadata: {
          type: "object",
          properties: { next_cursor: { type: "string" } },
        },
      },
    };
    expect(
      paginate([param("cursor"), param("limit", { type: "integer", default: 100 })], out),
    ).toEqual({
      style: "cursor",
      cursorParam: "cursor",
      itemsField: "channels",
      nextField: "response_metadata.next_cursor",
      pageSizeParam: "limit",
      defaultPageSize: 100,
    });
  });

  it("strips the OData/Socrata `$` sigil, which is syntax rather than meaning", () => {
    expect(
      paginate([
        param("offset", { type: "integer" }),
        param("$top", { type: "integer", maximum: 999 }),
      ]),
    ).toEqual({
      style: "offset",
      cursorParam: "offset",
      pageSizeParam: "$top",
      maxPageSize: 999,
    });
    expect(
      paginate([param("offset", { type: "integer" }), param("$limit", { type: "integer" })]),
    ).toMatchObject({
      pageSizeParam: "$limit",
    });
    expect(
      paginate([param("$skiptoken"), param("$top", { type: "integer", maximum: 100 })]),
    ).toMatchObject({
      style: "cursor",
      cursorParam: "$skiptoken",
      pageSizeParam: "$top",
      maxPageSize: 100,
    });
  });

  it("accepts the page-scoped spellings that admit no other reading", () => {
    for (const name of ["per_page", "perPage", "page_size", "pageSize", "pagelen", "PAGE_LEN"]) {
      expect(paginate([param("cursor"), param(name, { type: "integer" })])).toMatchObject({
        pageSizeParam: name,
      });
    }
  });
});

describe("classifyPagination — what it refuses to call a page size", () => {
  it.each([
    "count",
    "size",
    "num",
    "rows",
    "maxRecords",
    "offset_limit",
    "quantity",
  ])("leaves %s unset rather than risk rewriting a domain parameter", (name) => {
    const pag = paginate([param("cursor"), param(name, { type: "integer" })]);
    expect(pag).toEqual({ style: "cursor", cursorParam: "cursor" });
  });

  it("rejects a size-shaped name whose declared type cannot be a size", () => {
    // `top: boolean` ("return only the top match") is the shape the type guard
    // exists for: the name reads like a size, the contract says it is a flag.
    expect(paginate([param("cursor"), param("top", { type: "boolean" })])).toEqual({
      style: "cursor",
      cursorParam: "cursor",
    });
    expect(paginate([param("cursor"), param("limit", { type: "object" })])).toEqual({
      style: "cursor",
      cursorParam: "cursor",
    });
  });

  it("stays silent when two equally-specific size names compete", () => {
    // One of these may bound the page and the other the whole result set;
    // picking either would be a coin flip a serving surface then acts on.
    expect(
      paginate([
        param("cursor"),
        param("limit", { type: "integer" }),
        param("maxResults", { type: "integer" }),
      ]),
    ).toEqual({
      style: "cursor",
      cursorParam: "cursor",
    });
  });

  it("prefers a page-scoped name over a bare bound when both are declared", () => {
    // `per_page` is definitionally a page size; `limit` may cap the whole set.
    expect(
      paginate([
        param("cursor"),
        param("limit", { type: "integer" }),
        param("per_page", { type: "integer", maximum: 100 }),
      ]),
    ).toEqual({
      style: "cursor",
      cursorParam: "cursor",
      pageSizeParam: "per_page",
      maxPageSize: 100,
    });
  });

  it("does not turn a bare size param into evidence of pagination", () => {
    // A size control without a continuation control cannot page; reading it as
    // pagination would promise a second page that does not exist.
    expect(paginate([param("per_page", { type: "integer", maximum: 100 })])).toBeUndefined();
  });

  it("never infers pagination for a mutation, size param or not", () => {
    const create = classifyEffect("post", "createThing /things");
    expect(
      classifyPagination(
        create.effect,
        create.effect.action,
        [param("cursor"), param("per_page")],
        undefined,
      ),
    ).toBeUndefined();
  });
});

describe("classifyPagination — bounds are read, never inferred", () => {
  const withSchema = (schema: Record<string, unknown>) =>
    paginate([param("cursor"), param("per_page", { type: "integer", ...schema })]);

  it("declines to state a cap when exclusiveMaximum is present in either draft's form", () => {
    // draft-04 spells it as a boolean modifier on `maximum`, draft-06+ as a
    // number of its own. The readings differ by one, and an off-by-one cap is
    // the silent-truncation bug this field exists to prevent.
    expect(withSchema({ maximum: 100, exclusiveMaximum: true })).toEqual({
      style: "cursor",
      cursorParam: "cursor",
      pageSizeParam: "per_page",
    });
    expect(withSchema({ exclusiveMaximum: 101 })).toEqual({
      style: "cursor",
      cursorParam: "cursor",
      pageSizeParam: "per_page",
    });
  });

  it("drops a default that exceeds the stated cap, keeping the cap", () => {
    // A contract that contradicts itself gets the safety-relevant half kept.
    expect(withSchema({ maximum: 100, default: 250 })).toEqual({
      style: "cursor",
      cursorParam: "cursor",
      pageSizeParam: "per_page",
      maxPageSize: 100,
    });
  });

  it("ignores bounds that are not positive integers", () => {
    for (const schema of [
      { maximum: 0, default: 0 },
      { maximum: -1, default: -5 },
      { maximum: 99.5, default: 12.5 },
      { maximum: "100", default: "30" },
      { maximum: null, default: null },
    ]) {
      expect(withSchema(schema)).toEqual({
        style: "cursor",
        cursorParam: "cursor",
        pageSizeParam: "per_page",
      });
    }
  });

  it("accepts a size param typed as a string, as specs that stringify query params declare it", () => {
    expect(paginate([param("cursor"), param("per_page")])).toMatchObject({
      pageSizeParam: "per_page",
    });
  });

  it("emits a shape the AIR Pagination contract accepts", () => {
    // The classifier's output is assigned straight onto Operation.pagination,
    // so the schema is the real acceptance test for these new fields.
    const pag = paginate([
      param("starting_after"),
      param("limit", { type: "integer", default: 10, maximum: 100 }),
    ]);
    expect(Pagination.parse(pag)).toEqual(pag);
  });
});
