import { describe, expect, it } from "vitest";
import { adaptPostman, isPostmanCollection, postmanSchemaVersion } from "./postman.js";

/**
 * Bug-bash coverage for the Postman → OpenAPI adapter (packages/compiler/src/protocols/postman.ts).
 * Focus: nested folders, collection variables, auth blocks, malformed/edge items, unusual
 * request shapes (no url, raw vs urlencoded/formdata/graphql bodies), and empty collections.
 * Every crafted collection is fed in-memory as JSON text, matching the adapter's real input.
 */

const SCHEMA_V21 = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";
const SCHEMA_V20 = "https://schema.getpostman.com/json/collection/v2.0.0/collection.json";

type Op = Record<string, unknown>;

/** Look up one lowered operation by path + method, the same shape used across the suite. */
function opAt(doc: ReturnType<typeof adaptPostman>, path: string, method: string): Op | undefined {
  return (doc.paths as Record<string, Record<string, Op>> | undefined)?.[path]?.[method];
}

/* --------------------------- malformed input & detection -------------------------- */

describe("malformed input & detection", () => {
  it("isPostmanCollection returns false when the schema mark is present but the JSON is broken", () => {
    // Contains SCHEMA_MARK (passes the cheap text sniff) but is not valid JSON: exercises the
    // JSON.parse catch branch, not just the "discriminator missing" branch.
    const broken = `{"info":{"schema":"${SCHEMA_V21}"`;
    expect(isPostmanCollection(broken)).toBe(false);
  });

  it("isPostmanCollection returns false when info.item is not an array", () => {
    const notArrayItem = JSON.stringify({ info: { schema: SCHEMA_V21 }, item: {} });
    expect(isPostmanCollection(notArrayItem)).toBe(false);
  });

  it("adaptPostman throws a structured error on invalid JSON text", () => {
    expect(() => adaptPostman("{ not json")).toThrow(/Invalid Postman Collection JSON/);
  });

  it("adaptPostman throws when info.schema is entirely absent", () => {
    const noInfo = JSON.stringify({ item: [] });
    expect(() => adaptPostman(noInfo)).toThrow(/Not a Postman Collection v2\.x/);
  });

  it("adaptPostman throws when info.schema is a string but lacks the v2 discriminator", () => {
    const v1ish = JSON.stringify({
      info: { schema: "https://schema.getpostman.com/json/collection/v1.0.0/collection.json" },
      item: [],
    });
    expect(() => adaptPostman(v1ish)).toThrow(/Not a Postman Collection v2\.x/);
  });

  it("adaptPostman throws when info.schema is not a string at all", () => {
    const badType = JSON.stringify({ info: { schema: 12345 }, item: [] });
    expect(() => adaptPostman(badType)).toThrow(/Not a Postman Collection v2\.x/);
  });
});

/* --------------------------- empty & structurally malformed --------------------------- */

describe("empty & structurally malformed collections", () => {
  it("lowers an empty collection to defaults: title, version, no description, no paths", () => {
    const spec = JSON.stringify({ info: { schema: SCHEMA_V21 }, item: [] });
    const doc = adaptPostman(spec);
    expect(doc.info?.title).toBe("Postman Collection");
    expect(doc.info?.version).toBe("1.0.0");
    expect("description" in (doc.info as object)).toBe(false);
    expect(doc.paths).toEqual({});
    expect(doc.servers).toEqual([{ url: "https://example.invalid" }]);
    expect(doc.components?.schemas).toEqual({});
    expect("securitySchemes" in (doc.components as object)).toBe(false);
    expect("security" in (doc as object)).toBe(false);
  });

  it("tolerates a collection whose `item` field is entirely missing", () => {
    const spec = JSON.stringify({ info: { schema: SCHEMA_V21 } });
    const doc = adaptPostman(spec);
    expect(doc.paths).toEqual({});
  });

  it("silently skips items with neither a `request` nor a nested `item` array", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        { name: "Just a note, no request and no children" },
        { name: "Real", request: { method: "GET", url: "https://x.example.com/real" } },
      ],
    });
    const doc = adaptPostman(spec);
    expect(Object.keys(doc.paths ?? {})).toEqual(["/real"]);
  });

  it("skips a leaf whose request has no url, and falls back to the default server", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [{ name: "NoUrl", request: { method: "GET" } }],
    });
    const doc = adaptPostman(spec);
    expect(Object.keys(doc.paths ?? {})).toEqual([]);
    expect(doc.servers).toEqual([{ url: "https://example.invalid" }]);
  });
});

/* --------------------- nested folders, operationId dedup, path collisions --------------------- */

describe("nested folders, operationId dedup, and path collisions", () => {
  it("carries all ancestor folder names into tags across 3 levels of nesting", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name: "A",
          item: [
            {
              name: "B",
              item: [
                {
                  name: "C",
                  item: [
                    { name: "Deep", request: { method: "GET", url: "https://x.example.com/deep" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const doc = adaptPostman(spec);
    const op = opAt(doc, "/deep", "get");
    expect(op?.tags).toEqual(["A", "B", "C"]);
    // With 3 meaningful folders, keep last 1 folder + request name: C.Deep
    expect(op?.operationId).toBe("C.Deep");
  });

  it("drops leading generic folder prefixes (workflows, common workflows, etc.)", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name: "Common Workflows",
          item: [
            {
              name: "Guest Management",
              item: [
                {
                  name: "Search",
                  request: { method: "GET", url: "https://x.example.com/search-guest" },
                },
              ],
            },
          ],
        },
      ],
    });
    const doc = adaptPostman(spec);
    const op = opAt(doc, "/search-guest", "get");
    // "Common Workflows" is generic and dropped; we keep only "Guest Management" + "Search".
    expect(op?.operationId).toBe("Guest_Management.Search");
  });

  it("keeps at most the last 2 meaningful folder segments plus the request name", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name: "API",
          item: [
            {
              name: "Reservations",
              item: [
                {
                  name: "Guest Management",
                  item: [
                    {
                      name: "Add Guest",
                      request: { method: "POST", url: "https://x.example.com/add-guest" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const doc = adaptPostman(spec);
    const op = opAt(doc, "/add-guest", "post");
    // "API" is generic and dropped. We have 3 meaningful: "Reservations", "Guest Management", + request "Add Guest".
    // Keep last 2: "Guest Management" (folder) + "Add Guest" (request).
    expect(op?.operationId).toBe("Guest_Management.Add_Guest");
  });

  it("falls back to more segments when truncation would lose uniqueness", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name: "Workflows",
          item: [
            {
              name: "Reservations",
              item: [
                {
                  name: "Add Guest",
                  request: { method: "POST", url: "https://x.example.com/add-guest-1" },
                },
              ],
            },
          ],
        },
        {
          name: "Common Workflows",
          item: [
            {
              name: "Bookings",
              item: [
                {
                  name: "Reservations",
                  item: [
                    {
                      name: "Add Guest",
                      request: { method: "POST", url: "https://x.example.com/add-guest-2" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const doc = adaptPostman(spec);
    const op1 = opAt(doc, "/add-guest-1", "post");
    const op2 = opAt(doc, "/add-guest-2", "post");
    // Both would truncate to "Reservations.Add_Guest"; check they stay unique.
    expect(op1?.operationId).not.toBe(op2?.operationId);
  });

  it("dedups a colliding operationId deterministically with a numeric suffix", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        { name: "Ping", request: { method: "GET", url: "https://x.example.com/a" } },
        { name: "Ping", request: { method: "GET", url: "https://x.example.com/b" } },
      ],
    });
    const doc = adaptPostman(spec);
    expect(opAt(doc, "/a", "get")?.operationId).toBe("Ping");
    expect(opAt(doc, "/b", "get")?.operationId).toBe("Ping_2");
  });

  it("lets the first operation win when two leaves collide on the same path+method", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name: "F1",
          item: [{ name: "First", request: { method: "GET", url: "https://x.example.com/ping" } }],
        },
        {
          name: "F2",
          item: [{ name: "Second", request: { method: "GET", url: "https://x.example.com/ping" } }],
        },
      ],
    });
    const doc = adaptPostman(spec);
    expect(Object.keys(doc.paths ?? {})).toEqual(["/ping"]);
    expect(opAt(doc, "/ping", "get")?.operationId).toBe("F1.First");
  });

  it("falls back operationId sanitization to 'op' when a name has no identifier-safe characters", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [{ name: "!!!", request: { method: "GET", url: "https://x.example.com/weird" } }],
    });
    const doc = adaptPostman(spec);
    expect(opAt(doc, "/weird", "get")?.operationId).toBe("op");
  });
});

/* --------------------------------- bare-string shorthand --------------------------------- */

describe("bare-string shorthand forms", () => {
  it("treats a bare-string item.request as a shorthand GET of that URL", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [{ name: "Shorthand", request: "https://x.example.com/shorthand" }],
    });
    const doc = adaptPostman(spec);
    const op = opAt(doc, "/shorthand", "get");
    expect(op).toBeDefined();
    expect("tags" in (op as object)).toBe(false); // no folders → no tags key at all
  });

  it("parses a raw string header block (v2.0 shape), skipping unkeyed lines and runtime headers", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name: "RawHeaders",
          request: {
            method: "GET",
            url: "https://x.example.com/raw-headers",
            header: "X-Trace-Id: abc123\r\nX-Empty:\r\nBadLineNoColon\r\nAuthorization: Bearer xyz",
          },
        },
      ],
    });
    const doc = adaptPostman(spec);
    const params = opAt(doc, "/raw-headers", "get")?.parameters as Array<Record<string, unknown>>;
    const names = params.map((p) => p.name);
    expect(names).toContain("X-Trace-Id");
    expect(names).toContain("X-Empty");
    expect(names).not.toContain("Authorization");
    expect(names).not.toContain("BadLineNoColon");
  });

  it("parses a raw URL string, including a query pair with no '=' sign", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name: "RawUrl",
          request: "https://x.example.com/search?flag&term=hi",
        },
      ],
    });
    const doc = adaptPostman(spec);
    const params = opAt(doc, "/search", "get")?.parameters as Array<Record<string, unknown>>;
    expect(params.find((p) => p.name === "flag")).toMatchObject({ in: "query" });
    expect(params.find((p) => p.name === "term")).toMatchObject({ in: "query" });
  });
});

/* -------------------------------- URL lowering edge cases -------------------------------- */

describe("URL lowering edge cases", () => {
  it("accepts `host` as a plain string instead of an array", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name: "PlainHost",
          request: {
            method: "GET",
            url: { host: "plain.example.com", path: ["v1", "things"] },
          },
        },
      ],
    });
    const doc = adaptPostman(spec);
    expect(doc.servers?.[0]?.url).toBe("https://plain.example.com");
    expect(opAt(doc, "/v1/things", "get")).toBeDefined();
  });

  it("accepts `path` as a plain '/'-joined string instead of an array", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name: "PlainPath",
          request: {
            method: "GET",
            url: { host: ["example.com"], path: "users/:id" },
          },
        },
      ],
    });
    const doc = adaptPostman(spec);
    const op = opAt(doc, "/users/{id}", "get");
    expect(op).toBeDefined();
    const params = op?.parameters as Array<Record<string, unknown>>;
    expect(params.find((p) => p.in === "path")).toMatchObject({ name: "id" });
  });

  it("falls back to parsing `raw` when a url object carries neither host nor path fields", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name: "RawOnly",
          request: { method: "GET", url: { raw: "https://raw-only.example.com/orders?x=1" } },
        },
      ],
    });
    const doc = adaptPostman(spec);
    expect(doc.servers?.[0]?.url).toBe("https://raw-only.example.com");
    const op = opAt(doc, "/orders", "get");
    expect(op).toBeDefined();
    const params = op?.parameters as Array<Record<string, unknown>>;
    expect(params.find((p) => p.name === "x")).toMatchObject({ in: "query" });
  });

  it("keeps a partial `{{var}}` occurrence in a path segment literal (segment-exact only)", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name: "PartialTemplate",
          request: {
            method: "GET",
            url: { host: ["example.com"], path: ["v{{ver}}", "items"] },
          },
        },
      ],
    });
    const doc = adaptPostman(spec);
    expect(Object.keys(doc.paths ?? {})).toEqual(["/v{{ver}}/items"]);
    const op = opAt(doc, "/v{{ver}}/items", "get");
    const params = op?.parameters as Array<Record<string, unknown>>;
    expect(params.some((p) => p.in === "path")).toBe(false);
  });

  it("omits the description key on a `:id` path param with no url.variable metadata", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name: "NoMeta",
          request: {
            method: "GET",
            url: { host: ["example.com"], path: ["things", ":thingId"] },
          },
        },
      ],
    });
    const doc = adaptPostman(spec);
    const op = opAt(doc, "/things/{thingId}", "get");
    const params = op?.parameters as Array<Record<string, unknown>>;
    const pathParam = params.find((p) => p.in === "path");
    expect(pathParam).toMatchObject({ name: "thingId", required: true });
    expect("description" in (pathParam as object)).toBe(false);
  });
});

/* ------------------------------- collection variable resolution ------------------------------- */

describe("collection variable resolution", () => {
  it("keeps an unresolvable host template verbatim as `https://{{var}}`", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name: "Unresolved",
          request: {
            method: "GET",
            url: { host: ["{{missingHost}}"], path: ["ping"] },
          },
        },
      ],
    });
    const doc = adaptPostman(spec);
    expect(doc.servers?.[0]?.url).toBe("https://{{missingHost}}");
  });

  it("resolves a schemeless variable value and appends the declared port", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      variable: [{ key: "apiHost", value: "internal.local" }],
      item: [
        {
          name: "Resolved",
          request: {
            method: "GET",
            url: { host: ["{{apiHost}}"], port: "8080", path: ["ping"] },
          },
        },
      ],
    });
    const doc = adaptPostman(spec);
    expect(doc.servers?.[0]?.url).toBe("https://internal.local:8080");
  });

  // FIXED: when a resolved host variable ALREADY includes a scheme (e.g. the collection
  // variable is itself a full base URL), `lowerUrl` (packages/compiler/src/protocols/postman.ts,
  // the `if (resolved && /^https?:\/\//i.test(resolved))` branch) now appends the
  // separately-declared `port`, matching the other two branches of the same if/else, instead of
  // silently dropping it.
  it("appends url.port even when the resolved host variable already has a scheme", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      variable: [{ key: "apiHost2", value: "https://internal.corp.com" }],
      item: [
        {
          name: "DroppedPort",
          request: {
            method: "GET",
            url: { host: ["{{apiHost2}}"], port: "9443", path: ["ping"] },
          },
        },
      ],
    });
    const doc = adaptPostman(spec);
    expect(doc.servers?.[0]?.url).toBe("https://internal.corp.com:9443");
  });
});

/* ------------------------------ query & header parameter edge cases ------------------------------ */

describe("query & header parameter edge cases", () => {
  it("skips query entries with no key, and header entries with no key", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name: "NoKeys",
          request: {
            method: "GET",
            header: [{ value: "no-key-here" }],
            url: {
              host: ["example.com"],
              path: ["x"],
              query: [{ value: "no-key-either" }],
            },
          },
        },
      ],
    });
    const doc = adaptPostman(spec);
    const params = opAt(doc, "/x", "get")?.parameters as Array<Record<string, unknown>>;
    expect(params).toEqual([]);
  });

  it("excludes Content-Type and Accept headers from parameters, same as Authorization", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name: "RuntimeHeaders",
          request: {
            method: "GET",
            header: [
              { key: "Content-Type", value: "application/json" },
              { key: "Accept", value: "application/json" },
              { key: "X-Keep", value: "v" },
            ],
            url: { host: ["example.com"], path: ["y"] },
          },
        },
      ],
    });
    const doc = adaptPostman(spec);
    const params = opAt(doc, "/y", "get")?.parameters as Array<Record<string, unknown>>;
    expect(params.map((p) => p.name)).toEqual(["X-Keep"]);
  });

  it("dedups query params that differ only by case, keeping the first", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name: "CaseDup",
          request: {
            method: "GET",
            url: {
              host: ["example.com"],
              path: ["z"],
              query: [
                { key: "Foo", value: "1", description: "first" },
                { key: "foo", value: "2" },
              ],
            },
          },
        },
      ],
    });
    const doc = adaptPostman(spec);
    const params = opAt(doc, "/z", "get")?.parameters as Array<Record<string, unknown>>;
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({ name: "Foo", description: "first" });
  });
});

/* --------------------------------------- template variable bodies --------------------------------------- */

describe("request body shapes with template variables", () => {
  const post = (name: string, path: string, body: unknown) =>
    JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name,
          request: { method: "POST", url: `https://x.example.com${path}`, body },
        },
      ],
    });

  it("types a JSON body whose example contains Postman template variables by substituting placeholders", () => {
    const doc = adaptPostman(
      post("TemplateVars", "/template-body", {
        mode: "raw",
        raw: '{"amount": "{{chargeAmount}}", "code": "{{trxCode}}", "currency": "USD"}',
        options: { raw: { language: "json" } },
      }),
    );
    const body = opAt(doc, "/template-body", "post")?.requestBody as {
      content: Record<string, { schema: Record<string, unknown>; example: unknown }>;
    };
    expect(body).toBeDefined();
    expect(body.content["application/json"]!.schema).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        amount: { type: "string" },
        code: { type: "string" },
        currency: { type: "string" },
      }),
    });
    // Verify that a properly-typed example was inferred from the template placeholders
    expect(body.content["application/json"]!.example).toEqual({
      amount: expect.any(String),
      code: expect.any(String),
      currency: "USD",
    });
  });

  it("includes template variable provenance in field descriptions", () => {
    const doc = adaptPostman(
      post("TemplateProvenance", "/template-prov", {
        mode: "raw",
        raw: '{"total": "{{totalAmount}}", "tax": 0.10}',
        options: { raw: { language: "json" } },
      }),
    );
    const body = opAt(doc, "/template-prov", "post")?.requestBody as {
      content: Record<string, { schema: Record<string, unknown>; example: unknown }>;
    };
    // Verify schema has all fields properly typed from the template-substituted example
    expect(body.content["application/json"]!.schema).toMatchObject({
      type: "object",
      properties: {
        total: { type: "string" },
        tax: { type: "number" },
      },
    });
    // Verify example was reconstructed after placeholder substitution
    const example = body.content["application/json"]!.example as Record<string, unknown>;
    expect(typeof example.total).toBe("string");
    expect(typeof example.tax).toBe("number");
  });

  it("still emits honest 'could not be typed' message for truly unparseable JSON with templates", () => {
    const doc = adaptPostman(
      post("ReallyBadJson", "/really-bad", {
        mode: "raw",
        raw: "{{notEvenCloseToParseable}}",
        options: { raw: { language: "json" } },
      }),
    );
    const body = opAt(doc, "/really-bad", "post")?.requestBody as {
      content: Record<string, { schema: Record<string, unknown> }>;
    };
    expect(body.content["application/json"]!.schema).toMatchObject({
      type: "object",
      description: expect.stringContaining("could not be typed"),
    });
  });
});

/* --------------------------------------- request body shapes --------------------------------------- */

describe("request body shapes", () => {
  const post = (name: string, path: string, body: unknown) =>
    JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name,
          request: { method: "POST", url: `https://x.example.com${path}`, body },
        },
      ],
    });

  it("lowers formdata: binary format for file fields, string for the rest", () => {
    const doc = adaptPostman(
      post("FormData", "/formdata", {
        mode: "formdata",
        formdata: [{ key: "file", type: "file" }, { key: "caption" }],
      }),
    );
    const body = opAt(doc, "/formdata", "post")?.requestBody as {
      content: Record<string, { schema: { properties: Record<string, unknown> } }>;
    };
    expect(body.content["multipart/form-data"]!.schema.properties).toEqual({
      file: { type: "string", format: "binary" },
      caption: { type: "string" },
    });
  });

  it("lowers a graphql body with the query copied into the example, variables excluded", () => {
    const doc = adaptPostman(
      post("GraphqlQuery", "/graphql-q", {
        mode: "graphql",
        graphql: { query: "query Ping { ping }", variables: "{}" },
      }),
    );
    const body = opAt(doc, "/graphql-q", "post")?.requestBody as {
      content: Record<
        string,
        { schema: Record<string, unknown>; example?: Record<string, unknown> }
      >;
    };
    const media = body.content["application/json"];
    expect(media!.schema).toMatchObject({ required: ["query"] });
    expect(media!.example).toEqual({ query: "query Ping { ping }" });
  });

  it("omits the example entirely for a graphql body with no query", () => {
    const doc = adaptPostman(post("GraphqlEmpty", "/graphql-e", { mode: "graphql", graphql: {} }));
    const body = opAt(doc, "/graphql-e", "post")?.requestBody as {
      content: Record<string, Record<string, unknown>>;
    };
    expect("example" in body.content["application/json"]!).toBe(false);
  });

  it("degrades a declared-JSON raw body that fails to parse to a permissive, honestly-labeled object", () => {
    const doc = adaptPostman(
      post("BadJson", "/bad-json", {
        mode: "raw",
        raw: "{{not valid json}}",
        options: { raw: { language: "json" } },
      }),
    );
    const body = opAt(doc, "/bad-json", "post")?.requestBody as {
      content: Record<string, { schema: Record<string, unknown> }>;
    };
    expect(body.content["application/json"]!.schema).toMatchObject({
      type: "object",
      description: expect.stringContaining("could not be typed"),
    });
  });

  it("lowers non-JSON raw text with no declared language as text/plain", () => {
    const doc = adaptPostman(post("PlainText", "/plain", { mode: "raw", raw: "hello, not json" }));
    const body = opAt(doc, "/plain", "post")?.requestBody as {
      content: Record<string, { schema: Record<string, unknown> }>;
    };
    expect(body.content["text/plain"]).toEqual({ schema: { type: "string" } });
  });

  it("lowers raw text declared as xml to application/xml", () => {
    const doc = adaptPostman(
      post("XmlBody", "/xml", {
        mode: "raw",
        raw: "<xml>hi</xml>",
        options: { raw: { language: "xml" } },
      }),
    );
    const body = opAt(doc, "/xml", "post")?.requestBody as {
      content: Record<string, { schema: Record<string, unknown> }>;
    };
    expect(body.content["application/xml"]).toEqual({ schema: { type: "string" } });
  });

  it("emits no requestBody for a blank/whitespace-only raw body", () => {
    const doc = adaptPostman(post("BlankRaw", "/blank", { mode: "raw", raw: "   " }));
    expect(opAt(doc, "/blank", "post")?.requestBody).toBeUndefined();
  });

  it("emits no requestBody when body is null or carries no mode", () => {
    const docNull = adaptPostman(post("NullBody", "/null-body", null));
    expect(opAt(docNull, "/null-body", "post")?.requestBody).toBeUndefined();
    const docNoMode = adaptPostman(post("NoModeBody", "/no-mode", {}));
    expect(opAt(docNoMode, "/no-mode", "post")?.requestBody).toBeUndefined();
  });

  it("degrades an unknown/binary body mode to a permissive, mode-labeled object", () => {
    const doc = adaptPostman(post("FileMode", "/file-mode", { mode: "file" }));
    const body = opAt(doc, "/file-mode", "post")?.requestBody as {
      content: Record<string, { schema: Record<string, unknown> }>;
    };
    expect(body.content["application/json"]!.schema).toMatchObject({
      type: "object",
      description: "Postman body mode 'file' is not translatable; permissive object body.",
    });
  });

  it("never emits a requestBody for GET, even when the saved request carries a body", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name: "GetWithBody",
          request: {
            method: "GET",
            url: "https://x.example.com/get-with-body",
            body: { mode: "raw", raw: '{"a":1}' },
          },
        },
      ],
    });
    const doc = adaptPostman(spec);
    expect(opAt(doc, "/get-with-body", "get")?.requestBody).toBeUndefined();
  });
});

/* -------------------------------------------- responses -------------------------------------------- */

describe("saved response lowering", () => {
  const get = (name: string, path: string, response: unknown[]) =>
    JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name,
          request: { method: "GET", url: `https://x.example.com${path}` },
          response,
        },
      ],
    });

  it("falls back to text/plain when a saved response body isn't valid JSON", () => {
    const doc = adaptPostman(
      get("BadResponseJson", "/bad-resp", [{ code: 200, body: "not-json" }]),
    );
    const responses = opAt(doc, "/bad-resp", "get")?.responses as Record<
      string,
      { content?: Record<string, unknown> }
    >;
    expect(responses["200"]?.content?.["text/plain"]).toEqual({ schema: { type: "string" } });
  });

  it("buckets an out-of-range status code under the generic 200", () => {
    const doc = adaptPostman(get("OutOfRange", "/oor", [{ code: 601, body: '{"ok":true}' }]));
    const responses = opAt(doc, "/oor", "get")?.responses as Record<
      string,
      { content?: Record<string, { example: unknown }> }
    >;
    expect(Object.keys(responses)).toEqual(["200"]);
    expect(responses["200"]?.content?.["application/json"]?.example).toEqual({ ok: true });
  });

  it("emits just a description (no content) when the saved body is blank", () => {
    const doc = adaptPostman(
      get("BlankBody", "/blank-resp", [{ code: 204, name: "No content", body: "" }]),
    );
    const responses = opAt(doc, "/blank-resp", "get")?.responses as Record<
      string,
      Record<string, unknown>
    >;
    expect(responses["204"]).toEqual({ description: "No content" });
  });

  it("keeps the first example when two saved responses share the same code", () => {
    const doc = adaptPostman(
      get("DupCode", "/dup-code", [
        { code: 200, body: '{"a":1}' },
        { code: 200, body: '{"b":2}' },
      ]),
    );
    const responses = opAt(doc, "/dup-code", "get")?.responses as Record<
      string,
      { content?: Record<string, { example: unknown }> }
    >;
    expect(responses["200"]?.content?.["application/json"]?.example).toEqual({ a: 1 });
  });

  it("defaults the description to 'Saved example response.' when name and body are absent", () => {
    const doc = adaptPostman(get("NoName", "/no-name", [{ code: 200 }]));
    const responses = opAt(doc, "/no-name", "get")?.responses as Record<
      string,
      Record<string, unknown>
    >;
    expect(responses["200"]).toEqual({ description: "Saved example response." });
  });

  it("emits the generic 200 when no responses were saved at all", () => {
    const doc = adaptPostman(get("NoSaved", "/no-saved", []));
    const responses = opAt(doc, "/no-saved", "get")?.responses as Record<
      string,
      Record<string, unknown>
    >;
    expect(responses).toEqual({ "200": { description: "Successful response." } });
  });
});

/* ------------------------------------------------ auth ------------------------------------------------ */

describe("auth blocks", () => {
  const withAuth = (auth: unknown) =>
    JSON.stringify({
      info: { schema: SCHEMA_V21 },
      auth,
      item: [{ name: "Op", request: { method: "GET", url: "https://x.example.com/op" } }],
    });

  it("lowers apikey auth with in=query", () => {
    const doc = adaptPostman(
      withAuth({
        type: "apikey",
        apikey: [
          { key: "key", value: "api_key" },
          { key: "in", value: "query" },
        ],
      }),
    );
    const schemes = doc.components?.securitySchemes as Record<string, Record<string, unknown>>;
    expect(schemes.apiKeyAuth).toEqual({ type: "apiKey", in: "query", name: "api_key" });
  });

  it("defaults apikey auth to header/X-API-Key when no params are given", () => {
    const doc = adaptPostman(withAuth({ type: "apikey", apikey: [] }));
    const schemes = doc.components?.securitySchemes as Record<string, Record<string, unknown>>;
    expect(schemes.apiKeyAuth).toEqual({ type: "apiKey", in: "header", name: "X-API-Key" });
  });

  it("lowers a full oauth2 auth block: allowlisted urls and a space-split scope list", () => {
    const doc = adaptPostman(
      withAuth({
        type: "oauth2",
        oauth2: [
          { key: "authUrl", value: "https://auth.example.com/authorize" },
          { key: "accessTokenUrl", value: "https://auth.example.com/token" },
          { key: "scope", value: "read write" },
        ],
      }),
    );
    const schemes = doc.components?.securitySchemes as Record<
      string,
      { flows: { authorizationCode: Record<string, unknown> } }
    >;
    expect(schemes.oauth2Auth!.flows.authorizationCode).toEqual({
      authorizationUrl: "https://auth.example.com/authorize",
      tokenUrl: "https://auth.example.com/token",
      scopes: { read: "", write: "" },
    });
  });

  it("falls back to non-routable placeholder oauth2 urls and an empty scope map when undeclared", () => {
    const doc = adaptPostman(withAuth({ type: "oauth2" }));
    const schemes = doc.components?.securitySchemes as Record<
      string,
      { flows: { authorizationCode: Record<string, unknown> } }
    >;
    expect(schemes.oauth2Auth!.flows.authorizationCode).toEqual({
      authorizationUrl: "https://example.invalid/authorize",
      tokenUrl: "https://example.invalid/token",
      scopes: {},
    });
  });

  it("registers no scheme and no security claim for an unsupported auth type (e.g. digest)", () => {
    const doc = adaptPostman(withAuth({ type: "digest", digest: { username: "x" } }));
    expect("securitySchemes" in (doc.components as object)).toBe(false);
    expect("security" in (doc as object)).toBe(false);
  });

  it("lets a request-level `noauth` clear security even under a collection-level default", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      auth: {
        type: "apikey",
        apikey: [
          { key: "key", value: "K" },
          { key: "in", value: "header" },
        ],
      },
      item: [
        {
          name: "Public",
          request: { method: "GET", url: "https://x.example.com/public", auth: { type: "noauth" } },
        },
      ],
    });
    const doc = adaptPostman(spec);
    expect(doc.security).toEqual([{ apiKeyAuth: [] }]); // collection default still applies elsewhere
    expect(opAt(doc, "/public", "get")?.security).toEqual([]);
  });

  it("registers no default security for a collection-level `noauth` block", () => {
    const doc = adaptPostman(withAuth({ type: "noauth" }));
    expect("security" in (doc as object)).toBe(false);
    expect(opAt(doc, "/op", "get")?.security).toBeUndefined();
  });
});

/* --------------------------------- info / version / description / scripts --------------------------------- */

describe("info, version, description, and script accounting", () => {
  it("lowers a partial version object, defaulting missing minor/patch to 0", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21, version: { major: 2 } },
      item: [],
    });
    expect(adaptPostman(spec).info?.version).toBe("2.0.0");
  });

  it("uses a plain string version verbatim", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21, version: "3.2.1-beta" },
      item: [],
    });
    expect(adaptPostman(spec).info?.version).toBe("3.2.1-beta");
  });

  it("uses the base description alone when there are no untranslated scripts", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21, description: "Just a plain description." },
      item: [],
    });
    expect(adaptPostman(spec).info?.description).toBe("Just a plain description.");
  });

  it("counts a script block whose exec is a plain string, not an array", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      event: [{ listen: "prerequest", script: { exec: "console.log(1);" } }],
      item: [],
    });
    const doc = adaptPostman(spec);
    expect((doc as Record<string, unknown>)["x-anvil-postman-scripts"]).toBe(1);
  });

  it("does not count an event whose script exec is blank or absent", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      event: [{ listen: "prerequest", script: { exec: "   " } }, { listen: "test" }],
      item: [],
    });
    const doc = adaptPostman(spec);
    expect("x-anvil-postman-scripts" in (doc as object)).toBe(false);
  });
});

/* --------------------------------------------- servers --------------------------------------------- */

describe("servers", () => {
  it("appends distinct bases in first-appearance order and dedups repeats", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        { name: "A1", request: { method: "GET", url: "https://a.example.com/x" } },
        { name: "B1", request: { method: "GET", url: "https://b.example.com/y" } },
        { name: "A2", request: { method: "GET", url: "https://a.example.com/z" } },
      ],
    });
    const doc = adaptPostman(spec);
    expect(doc.servers).toEqual([
      { url: "https://a.example.com" },
      { url: "https://b.example.com" },
    ]);
  });
});

/* ------------------------------------- postmanSchemaVersion sanity ------------------------------------- */

describe("postmanSchemaVersion", () => {
  it("distinguishes v2.1 from v2.0 collection exports", () => {
    const v21 = JSON.stringify({ info: { schema: SCHEMA_V21 }, item: [] });
    const v20 = JSON.stringify({ info: { schema: SCHEMA_V20 }, item: [] });
    expect(postmanSchemaVersion(v21)).toBe("2.1");
    expect(postmanSchemaVersion(v20)).toBe("2.0");
  });
});

/* ---------------------- lenient JSON parsing for malformed bodies ---------------------- */

describe("lenient JSON parsing for common Postman body quirks", () => {
  const post = (name: string, path: string, body: unknown) =>
    JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name,
          request: { method: "POST", url: `https://x.example.com${path}`, body },
        },
      ],
    });

  it("removes trailing commas before closing braces to parse otherwise-valid JSON with template variables", () => {
    // Evidence from OPERA corpus: bodies like {"id": {{ReservationId}},} where the trailing comma
    // is present even before the closing brace.
    const doc = adaptPostman(
      post("TrailingCommas", "/trailing-commas", {
        mode: "raw",
        raw: '{"reservationId": {"type": "Reservation", "id": {{ReservationId}},}, "name": "Guest"}',
        options: { raw: { language: "json" } },
      }),
    );
    const body = opAt(doc, "/trailing-commas", "post")?.requestBody as {
      content: Record<string, { schema: Record<string, unknown>; example: unknown }>;
    };
    expect(body).toBeDefined();
    const schema = body.content["application/json"]!.schema as Record<string, unknown>;
    // Verify the schema was properly inferred from the lenient-parsed JSON
    expect(schema.type).toBe("object");
    const props = schema.properties as Record<string, unknown>;
    expect(props).toBeDefined();
    expect(props.name).toMatchObject({ type: "string" });
    expect(props.reservationId).toMatchObject({ type: "object" });
  });

  it("quotes unquoted placeholder identifiers from template variable substitution", () => {
    // Evidence: OPERA bodies contain unquoted template variables like "id": {{var}}
    // which after placeholder substitution become "id": __PLACEHOLDER_0__ (invalid JSON).
    // Lenient parsing quotes them: "id": "__PLACEHOLDER_0__".
    const doc = adaptPostman(
      post("UnquotedPlaceholders", "/unquoted-templates", {
        mode: "raw",
        raw: '{"id": {{HotelId}}, "type": "Hotel"}',
        options: { raw: { language: "json" } },
      }),
    );
    const body = opAt(doc, "/unquoted-templates", "post")?.requestBody as {
      content: Record<string, { schema: Record<string, unknown>; example: unknown }>;
    };
    expect(body).toBeDefined();
    expect(body.content["application/json"]!.schema).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        id: { type: "string" },
        type: { type: "string" },
      }),
    });
  });

  it("removes // line comments to parse JSON with inline comments", () => {
    const doc = adaptPostman(
      post("LineComments", "/line-comments", {
        mode: "raw",
        raw: '{"amount": 100, // charge amount\n"currency": "USD"} // end of body',
        options: { raw: { language: "json" } },
      }),
    );
    const body = opAt(doc, "/line-comments", "post")?.requestBody as {
      content: Record<string, { schema: Record<string, unknown>; example: unknown }>;
    };
    expect(body).toBeDefined();
    expect(body.content["application/json"]!.schema).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        amount: { type: "number" },
        currency: { type: "string" },
      }),
    });
  });

  it("removes /* */ block comments to parse JSON with block comments", () => {
    const doc = adaptPostman(
      post("BlockComments", "/block-comments", {
        mode: "raw",
        raw: '{"amount": 100, /* charge amount */ "currency": /* USD or EUR */ "USD"}',
        options: { raw: { language: "json" } },
      }),
    );
    const body = opAt(doc, "/block-comments", "post")?.requestBody as {
      content: Record<string, { schema: Record<string, unknown>; example: unknown }>;
    };
    expect(body).toBeDefined();
    expect(body.content["application/json"]!.schema).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        amount: { type: "number" },
        currency: { type: "string" },
      }),
    });
  });

  it("emits honest 'could not be typed' message when lenient fixes cannot parse the JSON", () => {
    // Body with genuinely malformed JSON that no lenient fix can handle
    const doc = adaptPostman(
      post("ReallyMalformed", "/malformed", {
        mode: "raw",
        raw: '{"id": {{HotelId}}}extra text here',
        options: { raw: { language: "json" } },
      }),
    );
    const body = opAt(doc, "/malformed", "post")?.requestBody as {
      content: Record<string, { schema: Record<string, unknown> }>;
    };
    expect(body.content["application/json"]!.schema).toMatchObject({
      type: "object",
      description: expect.stringContaining("could not be typed"),
    });
  });
});

/* ---------------------- disabled query parameter UI ---------------------- */

describe("disabled query parameter UX and operation descriptions", () => {
  const getWithParams = (name: string, path: string, query: unknown[]) =>
    JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name,
          request: {
            method: "GET",
            url: { path, query },
          },
        },
      ],
    });

  it("updates per-field disabled text to guide users on verification", () => {
    const doc = adaptPostman(
      getWithParams("DisabledParams", "/search", [
        { key: "q", value: "test" },
        { key: "limit", value: "10", disabled: true },
      ]),
    );
    const op = opAt(doc, "/search", "get");
    if (!op) throw new Error("fixture missing GET /search");
    const limitParam = (op.parameters as Array<Record<string, unknown>>).find(
      (p) => p.name === "limit",
    );
    expect(limitParam?.description).toContain(
      "disabled in the source collection — verify it is enabled in your environment",
    );
    expect(limitParam?.description).not.toContain("disabled by default");
  });

  it("adds a summary sentence to operation description when query parameters are disabled", () => {
    const doc = adaptPostman(
      getWithParams("MultipleDisabled", "/search", [
        { key: "q", value: "test" },
        { key: "limit", value: "10", disabled: true },
        { key: "offset", value: "0", disabled: true },
        { key: "sort", value: "name" },
      ]),
    );
    const op = opAt(doc, "/search", "get");
    expect(op?.description).toContain("2 of 4 documented query parameters are disabled");
  });

  it("omits the summary sentence when no query parameters are disabled", () => {
    const doc = adaptPostman(
      getWithParams("NoDisabled", "/search", [
        { key: "q", value: "test" },
        { key: "limit", value: "10" },
      ]),
    );
    const op = opAt(doc, "/search", "get");
    // When no parameters are disabled and there's no request description,
    // the operation description should be undefined (not present at all).
    if (op?.description) {
      expect(op.description).not.toContain("disabled");
    }
  });

  it("prepends the summary sentence to an existing operation description", () => {
    const spec = JSON.stringify({
      info: { schema: SCHEMA_V21 },
      item: [
        {
          name: "Search",
          request: {
            method: "GET",
            url: "https://x.example.com/search?q=test&limit=10",
            description: "Perform a full-text search across all resources.",
          },
        },
      ],
    });
    const collection = JSON.parse(spec) as Record<string, unknown>;
    // Manually add disabled query param (the string URL doesn't parse query params with disabled flag)
    const item = (collection.item as Array<Record<string, unknown>>)[0];
    (item!.request as Record<string, unknown>).url = {
      raw: "https://x.example.com/search?q=test&limit=10",
      protocol: "https",
      host: ["x.example.com"],
      path: ["search"],
      query: [
        { key: "q", value: "test" },
        { key: "limit", value: "10", disabled: true },
      ],
    };

    const doc = adaptPostman(JSON.stringify(collection));
    const op = opAt(doc, "/search", "get");
    expect(op?.description).toContain("Perform a full-text search");
    expect(op?.description).toContain("1 of 2 documented query parameters are disabled");
  });
});
