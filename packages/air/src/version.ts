/**
 * AIR format versioning. `AirDocument.anvilVersion` has been written as
 * "0.1.0" by every compile since the schema existed and read by nothing; this
 * module is where it is read. The rule is asymmetric, like every other gate
 * in Anvil: a document whose MAJOR version is newer than the running
 * toolchain is refused outright (its shape may carry semantics this toolchain
 * cannot see, and serving it as if it could is how an unreviewed operation
 * reaches an agent), while an older document is accepted with a warning and
 * a home for the migrations a future shape change will need.
 *
 * `migrateAir` runs over the RAW object before schema validation, because a
 * shape change is exactly the thing the current schema cannot parse. Today
 * the registry is empty and the hook is a pass-through; the point is that the
 * seam exists and is exercised by the loaders, so the first real migration
 * has a place to land instead of a scattering of `if (doc.anvilVersion ===`.
 */

/** The AIR format version this toolchain writes. Must equal the schema default. */
export const AIR_VERSION = "0.1.0";

export type AirCompatibility =
  | { verdict: "current"; version: string }
  | { verdict: "older"; version: string; message: string }
  | { verdict: "newer_minor"; version: string; message: string }
  | { verdict: "newer_major"; version: string; message: string }
  | { verdict: "unparseable"; version: string; message: string };

export class AirVersionError extends Error {
  readonly code: string;
  readonly compatibility: AirCompatibility;
  constructor(compatibility: Exclude<AirCompatibility, { verdict: "current" }>) {
    super(compatibility.message);
    this.name = "AirVersionError";
    this.code = "air/incompatible_version";
    this.compatibility = compatibility;
  }
}

function parseSemver(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Read `anvilVersion` off an unvalidated document; absent means the schema default. */
export function airVersionOf(raw: unknown): string {
  const value =
    raw && typeof raw === "object" ? (raw as { anvilVersion?: unknown }).anvilVersion : undefined;
  return typeof value === "string" ? value : AIR_VERSION;
}

/** Compare a document's `anvilVersion` to the toolchain's. */
export function airCompatibility(version: string, toolchain = AIR_VERSION): AirCompatibility {
  const theirs = parseSemver(version);
  const ours = parseSemver(toolchain);
  if (!theirs || !ours) {
    return {
      verdict: "unparseable",
      version,
      message: `AIR anvilVersion '${version}' is not a semantic version; this toolchain (${toolchain}) refuses to guess what shape the document has.`,
    };
  }
  if (theirs[0] > ours[0]) {
    return {
      verdict: "newer_major",
      version,
      message: `AIR anvilVersion ${version} is newer than this toolchain (${toolchain}) in its major version; upgrade anvil before reading this bundle.`,
    };
  }
  if (
    theirs[0] === ours[0] &&
    (theirs[1] > ours[1] || (theirs[1] === ours[1] && theirs[2] > ours[2]))
  ) {
    return {
      verdict: "newer_minor",
      version,
      message: `AIR anvilVersion ${version} is newer than this toolchain (${toolchain}); fields it added are ignored. Upgrade anvil to read them.`,
    };
  }
  if (theirs[0] < ours[0] || theirs[1] < ours[1] || theirs[2] < ours[2]) {
    return {
      verdict: "older",
      version,
      message: `AIR anvilVersion ${version} is older than this toolchain (${toolchain}); recompile the bundle to bring it current.`,
    };
  }
  return { verdict: "current", version };
}

/** Refuse a document this toolchain must not read; return the verdict otherwise. */
export function assertAirCompatible(raw: unknown, toolchain = AIR_VERSION): AirCompatibility {
  const compatibility = airCompatibility(airVersionOf(raw), toolchain);
  if (compatibility.verdict === "newer_major" || compatibility.verdict === "unparseable") {
    throw new AirVersionError(compatibility);
  }
  return compatibility;
}

/** A migration rewrites the RAW document of one older version range into the next shape. */
export interface AirMigration {
  id: string;
  /** Whether this migration applies to a document at `version` (a semver string). */
  appliesTo: (version: string) => boolean;
  apply: (raw: unknown) => unknown;
}

/** The registry a future shape change adds to. Empty today, by design. */
export const AIR_MIGRATIONS: readonly AirMigration[] = [];

export interface AirLoadOptions {
  /** Receives the compatibility message for an older or newer-minor document. */
  onWarning?: (message: string) => void;
  /** Overrides the registry (tests); production callers leave it. */
  migrations?: readonly AirMigration[];
}

/**
 * Bring a raw document to the current shape: check compatibility, then apply
 * every registered migration whose `appliesTo` matches, in registry order.
 * A no-op today; the loaders call it so the seam is live.
 */
export function migrateAir(raw: unknown, options: AirLoadOptions = {}): unknown {
  const compatibility = assertAirCompatible(raw);
  if (compatibility.verdict !== "current") options.onWarning?.(compatibility.message);
  let current = raw;
  for (const migration of options.migrations ?? AIR_MIGRATIONS) {
    if (migration.appliesTo(airVersionOf(current))) current = migration.apply(current);
  }
  return current;
}
