/**
 * How an operation pages: the contract every surface (the runtime, the MCP
 * server, the SDKs, the simulator) reads to continue a list or search.
 */
import { z } from "zod";

export const Pagination = z.object({
  style: z.enum(["cursor", "page", "offset", "link"]),
  cursorParam: z.string().optional(),
  /**
   * Where `cursorParam` and `pageSizeParam` travel. `body`: they are fields of
   * the request body, as on a POST search that carries its continuation token
   * there (Jira `POST /rest/api/3/search/jql` sends `nextPageToken` and
   * `maxResults` in the body and answers with `nextPageToken`). Absent: they
   * are declared parameters.
   */
  in: z.enum(["body"]).optional(),
  /**
   * A top-level response field is named literally even when it contains a dot
   * (OData's `@odata.nextLink`); any other dotted value is a path.
   */
  nextField: z.string().optional(),
  itemsField: z.string().optional(),
  /**
   * The parameter that controls page *size* (`per_page`, `limit`, `maxResults`,
   * `page_size`, `top`, …). Distinct from `cursorParam`, which only controls
   * *continuation*. This is the single knob that lets a serving surface hold a
   * response inside a token budget by asking for less, rather than fetching
   * everything and cutting it afterwards — so without it, truncation is the
   * only tool available and the upstream cost is paid regardless.
   */
  pageSizeParam: z.string().optional(),
  /**
   * The largest page the upstream will actually honor, when the contract states
   * it. Recorded because exceeding it is *silent*: an agent that asks for 500
   * and receives 100 has no way to tell a full page from a capped one, and will
   * report a partial read as complete. A serving surface clamps to this and can
   * treat `returned === maxPageSize && no continuation` as suspicious.
   */
  maxPageSize: z.number().int().positive().optional(),
  /** The page size the upstream applies when the caller omits one. */
  defaultPageSize: z.number().int().positive().optional(),
});
export type Pagination = z.infer<typeof Pagination>;

/**
 * The key path a pagination field names in a response. A dotted value is a
 * path (`response_metadata.next_cursor`), except an OData annotation such as
 * `@odata.nextLink`, whose dot is part of one top-level key.
 */
export function responseFieldPath(field: string): string[] {
  return field.startsWith("@") ? [field] : field.split(".");
}

/**
 * Whether a pagination contract is OData's server-driven paging: the next
 * request arrives as a URL in `@odata.nextLink` carrying `$skiptoken`, and a
 * client may also continue with `$skip`.
 */
export function isODataPaging(pagination: Pagination | undefined): boolean {
  return pagination?.style === "link" && pagination.nextField === "@odata.nextLink";
}
