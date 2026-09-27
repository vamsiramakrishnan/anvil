import type { Effect, JsonSchema, OperationAction, Param, RequestBody } from "@anvil/air";
import { inferPaginationResponseFields } from "./pagination-response.js";

/**
 * Pagination inference: which parameters (or request-body fields) continue a
 * list or search, which one sizes a page, and where the response carries the
 * items and the continuation. Split out of classify.ts, which owns effect and
 * safety classification; paging is description, never a safety input.
 */
/* --- pagination inference ------------------------------------------------- */

/**
 * Continuation-param names by style, most specific first. Cursor-style names
 * beat page-style when both are present (e.g. Twilio carries PageToken AND
 * Page — PageToken is the operative continuation). Measured against the real
 * corpus: starting_after (Stripe), cursor (Slack), PageToken (Twilio),
 * page/per_page (GitHub), startAt/maxResults (Jira).
 */
const CURSOR_PARAM_NAMES = new Set([
  "cursor",
  "starting_after",
  "page_token",
  "pagetoken",
  "next_page_token", // Jira's enhanced search (`nextPageToken`), in its query or body
  "nextpagetoken",
  "next_token",
  "nexttoken",
  "skip_token",
  "skiptoken",
  "after",
]);
const PAGE_PARAM_NAMES = new Set(["page"]);
const OFFSET_PARAM_NAMES = new Set(["offset", "startat", "skip"]);

/**
 * Page-*size* names, in two ranked tiers. The tiering is not cosmetic: a name
 * with "page" in it can only mean the size of one page, whereas a bare bound
 * like `limit` means "at most this many results" and in some dialects bounds
 * the whole result set rather than one page. When a spec carries both, the
 * page-scoped name is the one that is definitionally a page size, so it wins.
 *
 * Every name here had to survive one test: read alone, out of context, does it
 * plainly name *how many results come back*? That is a much higher bar than
 * "some real API uses it as a page size", and it is the right bar, because the
 * cost of a false positive is not a missing field — it is a serving surface
 * rewriting a domain parameter to hit a token budget, silently changing what
 * the caller asked for.
 */
const PAGE_SIZE_PARAM_NAMES = new Set([
  "per_page", // GitHub, Bitbucket-adjacent; "per page" admits no other reading
  "perpage",
  "page_size", // Google APIs (AIP-158), Notion; likewise unambiguous
  "pagesize",
  "pagelen", // Bitbucket
  "page_len",
]);
const RESULT_LIMIT_PARAM_NAMES = new Set([
  "limit", // Stripe, Slack, Twilio, Shopify — and see the `size` note below
  "max_results", // Jira maxResults, Google Calendar/YouTube maxResults
  "maxresults",
  "top", // OData $top; the `$` is stripped before lookup (also covers Socrata $limit)
]);

/**
 * Names deliberately NOT treated as page sizes, each with the corpus instance
 * that makes it tempting and the reason it still loses:
 *
 *  - `count` — reads as a *question* at least as often as a quantity. OData's
 *    `$count` is a boolean asking for a total (and would normalize to `count`
 *    under `$`-stripping, so it collides exactly), and plenty of specs use
 *    `count` as a filter. Rewriting it changes what is being asked, not how
 *    much of it comes back. X/Twitter v1.1 is the tempting instance.
 *  - `size` — the most collision-prone name in the candidate set: file size,
 *    image size, instance size, apparel size. Spring Data's `page`+`size` and
 *    Elasticsearch's `from`+`size` are real and common, which is precisely why
 *    getting it wrong is expensive. The distinction against `limit`: `limit` is
 *    a *bound* word, and a bound on a list query can only bound the list;
 *    `size` is a *magnitude* word that attaches to any noun in the domain.
 *  - `num` — Google Custom Search really does use it, but "num" names no noun
 *    at all, so there is nothing in the name to check the reading against.
 *  - `rows` — Solr's `rows` is a genuine page size, yet the word names the
 *    *things*, not how many of them; a `rows` param could as easily select rows
 *    or carry them.
 *  - `maxRecords` — the trap in this list. Airtable's `maxRecords` caps the
 *    TOTAL across the whole paged iteration; its page size is `pageSize`. A
 *    surface that wrote a token budget into `maxRecords` would silently
 *    truncate the result *set*, and page two would come back empty while
 *    looking complete — the exact failure class `maxPageSize` exists to expose.
 *
 * None of these are "wrong forever": they are unproven here, which is what the
 * `document-pagination` refinement skill is for. Evidence can promote them;
 * a name guess must not.
 */

/**
 * Declared types a page size cannot have, however size-ish the name reads —
 * a boolean `count`-style flag or a structured value wearing a size name.
 * `string` is tolerated on purpose: AIR defaults an untyped param to
 * `type: string` and many specs type every query param as a string, so
 * rejecting it would drop honest page sizes to catch nothing.
 */
const NON_SIZE_SCHEMA_TYPES = new Set(["boolean", "array", "object", "null"]);
/**
 * Rank a parameter as a page-size control, lower being more specific, or
 * `undefined` when the name is not one we will act on.
 *
 * The leading `$` is stripped because two dialects put their paging knobs in a
 * reserved namespace — OData (`$top`) and Socrata (`$limit`) — and the sigil is
 * syntax, not meaning. Stripping is confined to this lookup rather than shared
 * with the continuation-param lookup above, so the change cannot move an
 * existing style classification.
 */
function pageSizeRank(param: Pick<Param, "name" | "schema">): number | undefined {
  const declaredType = param.schema?.type;
  if (typeof declaredType === "string" && NON_SIZE_SCHEMA_TYPES.has(declaredType)) return undefined;
  const n = param.name.toLowerCase().replace(/^\$/, "");
  if (PAGE_SIZE_PARAM_NAMES.has(n)) return 0;
  if (RESULT_LIMIT_PARAM_NAMES.has(n)) return 1;
  return undefined;
}

/**
 * Read the upstream's own stated bounds off the size parameter's schema. These
 * are facts the contract declares, not inferences from it — which is the whole
 * reason they are safe to record here rather than defer to refinement.
 *
 * `maximum` matters more than it looks: exceeding a page-size cap is *silent*.
 * An agent that asks for 500 and gets 100 cannot distinguish a full page from a
 * capped one and will report a partial read as complete — a confidently wrong
 * answer, which is worse than an error. Recording the cap lets a serving
 * surface clamp before it asks, and lets certification reason about the page it
 * will actually get.
 */
function pageSizeBounds(schema: Record<string, unknown> | undefined): {
  maxPageSize?: number;
  defaultPageSize?: number;
} {
  const positiveInt = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;

  // `exclusiveMaximum` is a boolean modifier on `maximum` in draft-04 and a
  // number in its own right from draft-06 on. The two readings differ by one,
  // and the wrong one reintroduces exactly the silent-cap error this field
  // exists to prevent — so when it is present in any form we decline to state a
  // cap at all rather than state one that may be off by one.
  const max = "exclusiveMaximum" in (schema ?? {}) ? undefined : positiveInt(schema?.maximum);
  let dflt = positiveInt(schema?.default);

  // A default above the stated cap is a self-contradictory contract. Keep the
  // cap (it is the safety-relevant half) and drop the default, because
  // `safePageSize` treats `defaultPageSize` as the upstream's own honest
  // answer, and feeding it a value the upstream will silently clamp would
  // manufacture the capped-page failure from inside Anvil.
  if (max !== undefined && dflt !== undefined && dflt > max) dflt = undefined;

  return {
    ...(max !== undefined ? { maxPageSize: max } : {}),
    ...(dflt !== undefined ? { defaultPageSize: dflt } : {}),
  };
}

/**
 * Infer pagination for a search-archetype read from unambiguous parameter
 * names, so generated surfaces can teach paging (and the MCP truncation
 * marker can name the cursor param) without waiting for enrichment. Inference
 * is deliberately conservative — a name that plainly IS a continuation param,
 * nothing fuzzier; anything ambiguous stays unset for the document-pagination
 * refinement skill to prove from evidence. Emits only fields it can ground:
 * itemsField only when the response object has exactly one array property,
 * nextField only when exactly one next-marker property matches.
 *
 * `pageSizeParam` is grounded the same way and matters for a different reason
 * than the rest. `cursorParam` only controls *continuation* — with it alone the
 * sole way to hold a response inside a context budget is to fetch everything
 * and cut it afterwards, paying the upstream cost regardless and handing the
 * agent a truncated payload. A size param is the one knob that lets a surface
 * ask for less. Detected only alongside a continuation param, so an operation
 * that merely happens to carry a `limit` is never reinterpreted as paginated.
 */
export function classifyPagination(
  effect: Effect,
  action: OperationAction,
  params: readonly Param[],
  outputSchema: Record<string, unknown> | undefined,
  body?: RequestBody,
):
  | {
      style: "cursor" | "page" | "offset" | "link";
      cursorParam: string;
      in?: "body";
      nextField?: string;
      itemsField?: string;
      pageSizeParam?: string;
      maxPageSize?: number;
      defaultPageSize?: number;
    }
  | undefined {
  if (effect.kind !== "read" || (action !== "search" && action !== "list")) return undefined;

  const responseFields = inferPaginationResponseFields(outputSchema);
  const odata = odataPagination(params, outputSchema);
  if (odata)
    return {
      ...odata,
      ...(responseFields.itemsField ? { itemsField: responseFields.itemsField } : {}),
    };

  const fromParams = continuationAmong(params);
  // A continuation token carried in the request body (a POST search) counts
  // only when the response hands one back: the request field alone could be
  // any token-shaped input, while the pair is the paging contract itself.
  const bodyFields = fromParams ? [] : bodyCandidates(body);
  const fromBody =
    !fromParams && responseFields.nextField ? continuationAmong(bodyFields) : undefined;
  const match = fromParams ?? fromBody;
  if (!match) return undefined;

  // Take a size param only when exactly one candidate holds the most specific
  // rank. Two equally-plausible size names on one operation is a real ambiguity
  // (one may bound the page and the other the whole set), and picking either is
  // a coin flip a serving surface would then act on — so we stay silent, the
  // same rule the itemsField/nextField "exactly one" tests apply below.
  const size = pageSizeAmong(fromBody ? bodyFields : params);

  const { nextLinkField, ...fields } = responseFields;
  // A cursor handed back only inside a next-page URL (`_links.next`) is link
  // paging: the client reads the cursor parameter out of that URL.
  const link =
    match.style === "cursor" && !fields.nextField && nextLinkField
      ? { style: "link" as const, nextField: nextLinkField }
      : {};
  return {
    ...match,
    ...(fromBody ? { in: "body" as const } : {}),
    ...fields,
    ...link,
    ...(size ?? {}),
  };
}

type PagingCandidate = Pick<Param, "name" | "schema">;

/** The continuation among some named inputs; cursor-style names win over page/offset. */
function continuationAmong(
  candidates: readonly PagingCandidate[],
): { style: "cursor" | "page" | "offset"; cursorParam: string } | undefined {
  const styleOf = (name: string): "cursor" | "page" | "offset" | undefined => {
    const n = name.toLowerCase().replace(/^\$/, "");
    if (CURSOR_PARAM_NAMES.has(n)) return "cursor";
    if (PAGE_PARAM_NAMES.has(n)) return "page";
    if (OFFSET_PARAM_NAMES.has(n)) return "offset";
    return undefined;
  };
  let match: { style: "cursor" | "page" | "offset"; cursorParam: string } | undefined;
  for (const p of candidates) {
    const style = styleOf(p.name);
    if (!style) continue;
    // Cursor-style names win over page/offset when a spec carries both.
    if (!match || (style === "cursor" && match.style !== "cursor")) {
      match = { style, cursorParam: p.name };
    }
  }
  return match;
}

function pageSizeAmong(
  candidates: readonly PagingCandidate[],
): { pageSizeParam: string; maxPageSize?: number; defaultPageSize?: number } | undefined {
  let best: { param: PagingCandidate; rank: number } | undefined;
  let tied = false;
  for (const p of candidates) {
    const rank = pageSizeRank(p);
    if (rank === undefined) continue;
    if (!best || rank < best.rank) {
      best = { param: p, rank };
      tied = false;
    } else if (rank === best.rank) {
      tied = true;
    }
  }
  return best && !tied
    ? { pageSizeParam: best.param.name, ...pageSizeBounds(best.param.schema) }
    : undefined;
}

/** A JSON request body's top-level fields, projected or not. */
function bodyCandidates(body: RequestBody | undefined): PagingCandidate[] {
  if (!body || !/json/i.test(body.contentType)) return [];
  if (body.projection === "fields") return body.fields;
  const props = body.schema?.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return [];
  return Object.entries(props as Record<string, unknown>).map(([name, schema]) => ({
    name,
    schema: (schema && typeof schema === "object" ? schema : {}) as JsonSchema,
  }));
}

/** OData's server-driven paging: the next page's URL, `$skiptoken` inside it. */
const ODATA_NEXT_LINK = "@odata.nextLink";
const ODATA_PAGING_PARAMS = new Set(["$top", "$skip", "$skiptoken"]);

/**
 * OData collections (Microsoft Graph, SAP, Dynamics) page by handing back the
 * next request as a URL in `@odata.nextLink`, which carries a `$skiptoken` (or
 * a `$skip`) the server chose. The two facts together are the contract: a
 * declared `$top`/`$skip`/`$skiptoken` system query option, and the
 * `@odata.nextLink` annotation on the declared response. Either alone is not.
 */
function odataPagination(
  params: readonly Param[],
  outputSchema: Record<string, unknown> | undefined,
):
  | {
      style: "link";
      cursorParam: string;
      nextField: string;
      pageSizeParam?: string;
      maxPageSize?: number;
      defaultPageSize?: number;
    }
  | undefined {
  const props = outputSchema?.properties;
  if (!props || typeof props !== "object" || !(ODATA_NEXT_LINK in props)) return undefined;
  const query = params.filter((p) => p.in === "query");
  if (!query.some((p) => ODATA_PAGING_PARAMS.has(p.name.toLowerCase()))) return undefined;
  const top = query.find((p) => p.name.toLowerCase() === "$top");
  return {
    style: "link",
    cursorParam: "$skiptoken",
    nextField: ODATA_NEXT_LINK,
    ...(top ? { pageSizeParam: top.name, ...pageSizeBounds(top.schema) } : {}),
  };
}
