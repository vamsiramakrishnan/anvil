/**
 * How an operation pages: the contract every surface (the runtime, the MCP
 * server, the SDKs, the simulator) reads to continue a list or search.
 */
import { z } from "zod";

export const Pagination = z.object({
  style: z.enum(["cursor", "page", "offset", "link"]),
  cursorParam: z.string().optional(),
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
