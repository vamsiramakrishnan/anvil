import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AirDocument } from "@anvil/air";
import { loadAir, resolveAirPath, writeAir } from "./air-file.js";
import type { SemanticChange } from "./apply.js";
import type { Refinement } from "./model.js";
import {
  applyReviewed,
  createReviewReceipt,
  type RefinementPack,
  type RefinementReviewReceipt,
  type ReviewDecision,
} from "./pack.js";
import { parseRefinementPack, parseRefinementReviewReceipt } from "./pack-schema.js";

/**
 * A refinement pack on disk. `pack.ts` is pure — packs, receipts, and their
 * verification are values — and this module is the one place those values
 * meet a directory: `pack.json` and `receipts/*.json` under a pack dir, and
 * the bundle's canonical AIR when a reviewed pack is applied. The CLI's
 * `refine approve|reject|apply-pack` and any other caller (a console) go
 * through these functions so a decision recorded by one is a decision the
 * other reads, byte for byte.
 */

/** Read and validate `pack.json` from a pack directory. */
export function readPackDir(dir: string): RefinementPack {
  const path = join(dir, "pack.json");
  if (!existsSync(path)) {
    throw new Error(`No pack.json in ${dir}. Run \`anvil refine run --out ${dir}\` first.`);
  }
  return parseRefinementPack(JSON.parse(readFileSync(path, "utf8")));
}

export interface PackDecisionRecord {
  refinementId: string;
  /** Where the receipt was written: `<pack-dir>/receipts/<id>.<decision>.json`. */
  path: string;
  receipt: RefinementReviewReceipt;
}

/**
 * Record a receipt-bound human decision for each refinement id. Every receipt
 * is created (and so validated against the pack) and every destination checked
 * BEFORE any file is written: a decision that already exists is refused, never
 * silently replaced, and one bad id writes nothing.
 */
export function recordPackDecision(
  packDir: string,
  decision: ReviewDecision,
  refinementIds: readonly string[],
  reviewer: string,
  reason: string,
): PackDecisionRecord[] {
  const pack = readPackDir(packDir);
  const receiptsDir = join(packDir, "receipts");
  const pending = refinementIds.map((id) => {
    const receipt = createReviewReceipt(pack, id, decision, reviewer, reason);
    const safeId = id.replace(/[^A-Za-z0-9._-]+/g, "_");
    const path = join(receiptsDir, `${safeId}.${decision}.json`);
    if (existsSync(path)) {
      throw new Error(
        `Receipt already exists: ${path}. Remove it deliberately before replacing a decision.`,
      );
    }
    return { refinementId: id, path, receipt };
  });
  mkdirSync(receiptsDir, { recursive: true });
  for (const { path, receipt } of pending) {
    writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  }
  return pending;
}

/**
 * Every receipt a pack carries (`receipts/*.json`, sorted) plus any extra
 * receipt files, deduplicated by path and validated.
 */
export function readPackReceipts(
  packDir: string,
  extraReceiptFiles: readonly string[] = [],
): RefinementReviewReceipt[] {
  const receiptPaths: string[] = [];
  const receiptsDir = join(packDir, "receipts");
  if (existsSync(receiptsDir)) {
    receiptPaths.push(
      ...readdirSync(receiptsDir)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => join(receiptsDir, name)),
    );
  }
  receiptPaths.push(...extraReceiptFiles);
  return [...new Set(receiptPaths)].map((receiptPath) =>
    parseRefinementReviewReceipt(JSON.parse(readFileSync(receiptPath, "utf8"))),
  );
}

export interface ApplyPackOptions {
  /** Additional receipt files beyond `<pack-dir>/receipts/*.json`. */
  receiptFiles?: readonly string[];
  /** Compute the semantic diff without writing AIR. */
  dryRun?: boolean;
}

export interface ApplyPackResult {
  /** The canonical AIR file the pack was applied to (and written to, unless dry-run or no-op). */
  airPath: string;
  air: AirDocument;
  applied: Refinement[];
  changes: SemanticChange[];
  /** True when AIR was written. False on dry-run and when nothing was approved. */
  written: boolean;
}

/**
 * Apply an existing measured pack plus its receipt-bound decisions to the
 * bundle's canonical AIR — the exact reviewed bytes, no investigation rerun —
 * and write AIR back in its own format. This writes AIR only; the bundle's
 * generated projections are the generators' to regenerate (the CLI says so:
 * "Regenerate the bundle with `anvil compile`").
 */
export function applyPackToBundle(
  bundlePath: string,
  packDir: string,
  opts: ApplyPackOptions = {},
): ApplyPackResult {
  const airPath = resolveAirPath(bundlePath);
  const air = loadAir(bundlePath);
  const pack = readPackDir(packDir);
  const receipts = readPackReceipts(packDir, opts.receiptFiles ?? []);
  const { air: next, applied, changes } = applyReviewed(air, pack, receipts);
  const written = applied.length > 0 && opts.dryRun !== true;
  if (written) writeAir(airPath, next);
  return { airPath, air: next, applied, changes, written };
}
