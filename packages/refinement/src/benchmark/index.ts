/**
 * The routing benchmark's pure core: the two catalogs and the routers
 * (`routing.ts`), mis-route clustering into confusable families
 * (`clusters.ts`), and the typed report those results are written as
 * (`report.ts`). Everything here is a function over AIR and report data; the
 * `anvil benchmark` command in `@anvil/cli` runs the loop and writes the file,
 * and the group rails in `protocol/group.ts` read the clusters back and score
 * proposals with the same lexical router — one router, so a proposal is judged
 * by the instrument that measured the problem.
 */

export * from "./clusters.js";
export * from "./report.js";
export * from "./routing.js";
