import { airCompatibility, type Diagnostic, nearestMatch, type Operation } from "@anvil/air";
import { isMap, LineCounter, parseDocument } from "yaml";
import { AnvilManifest, operationMatchesKey } from "./manifest.js";

/**
 * Manifest parsing and authoring diagnostics: the reviewer-facing half of the
 * manifest, split from the schema and its application in `manifest.ts`.
 */
/**
 * Every manifest object is `strictObject`: a key the schema does not know is
 * an error, never silently dropped. The manifest is the one file a human
 * writes to change what an operation MEANS — a misspelled `idempotency` or
 * `side_effect` that compiled clean and applied nothing was the worst kind of
 * failure this tool can have, because the reviewer believed a safety overlay
 * was in force. (`side_effect` and `idempotancy` were both real.)
 */
export interface ManifestIssue {
  /** JSON-pointer-style path into the manifest (`operations.createRefund.idempotency`). */
  path: string;
  message: string;
  /** 1-based position in the YAML source, when the offending node could be located. */
  line?: number;
  col?: number;
  /** For an unknown key: the closest key the schema does accept, when one is plausible. */
  suggestion?: string;
}

export class ManifestParseError extends Error {
  readonly issues: readonly ManifestIssue[];
  constructor(issues: readonly ManifestIssue[]) {
    super(
      `Manifest is invalid:\n${issues.map((issue) => `  ${formatManifestIssue(issue)}`).join("\n")}`,
    );
    this.name = "ManifestParseError";
    this.issues = issues;
  }
}

/** `line:col path: message (did you mean …?)` — one line per issue. */
export function formatManifestIssue(issue: ManifestIssue, file?: string): string {
  const where =
    issue.line !== undefined
      ? `${file ?? "manifest"}:${issue.line}:${issue.col ?? 1} `
      : file
        ? `${file} `
        : "";
  const at = issue.path ? `${issue.path}: ` : "";
  const hint = issue.suggestion ? ` (did you mean '${issue.suggestion}'?)` : "";
  return `${where}${at}${issue.message}${hint}`;
}

export type ManifestParseResult =
  | { ok: true; manifest: AnvilManifest }
  | { ok: false; issues: ManifestIssue[] };

/**
 * Parse a manifest and report every problem with its position in the source,
 * instead of throwing a raw schema error. YAML syntax errors, schema
 * violations, and unknown keys all come back as `ManifestIssue`s, each located
 * to a line and column where the YAML node can be found.
 */
export function parseManifestDetailed(text: string): ManifestParseResult {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter, keepSourceTokens: true });
  if (doc.errors.length > 0) {
    return {
      ok: false,
      issues: doc.errors.map((error) => {
        const offset = error.pos?.[0];
        const pos = offset !== undefined ? counter.linePos(offset) : undefined;
        return {
          path: "",
          message: error.message.split("\n")[0] ?? error.message,
          ...(pos ? { line: pos.line, col: pos.col } : {}),
        };
      }),
    };
  }
  const raw = doc.toJS() as unknown;
  const parsed = AnvilManifest.safeParse(raw ?? {});
  if (parsed.success) {
    // A manifest written for a newer toolchain may use keys this one does not
    // know; the strict-key rule already refuses those, but a `version` that
    // says so outright is refused first, with the reason, rather than as a
    // scatter of "unknown key" issues.
    const compatibility =
      parsed.data.version === undefined ? undefined : airCompatibility(parsed.data.version);
    if (
      compatibility &&
      (compatibility.verdict === "newer_major" || compatibility.verdict === "unparseable")
    ) {
      const pos = doc.getIn(["version"], true) as { range?: [number, number, number] } | undefined;
      return {
        ok: false,
        issues: [
          {
            path: "version",
            message: compatibility.message.replace(/^AIR anvilVersion/, "manifest version"),
            ...(pos?.range ? counter.linePos(pos.range[0]) : {}),
          },
        ],
      };
    }
    return { ok: true, manifest: parsed.data };
  }
  // The position of the KEY at `path` (where a reviewer's eye lands), falling
  // back to the value, then to the nearest located ancestor.
  const locate = (path: readonly PropertyKey[]): { line: number; col: number } | undefined => {
    let probe: readonly PropertyKey[] = path;
    while (true) {
      const last = probe[probe.length - 1];
      const parentPath = probe.slice(0, -1);
      const parent =
        parentPath.length > 0 ? doc.getIn(parentPath as (string | number)[], true) : doc.contents;
      if (last !== undefined && isMap(parent)) {
        const pair = parent.items.find(
          (item) => String((item.key as { value?: unknown })?.value ?? item.key) === String(last),
        );
        const keyRange = (pair?.key as { range?: [number, number, number] } | undefined)?.range;
        if (keyRange) return counter.linePos(keyRange[0]);
      }
      const node = probe.length > 0 ? doc.getIn(probe as (string | number)[], true) : doc.contents;
      const range = (node as { range?: [number, number, number] } | null | undefined)?.range;
      if (range) return counter.linePos(range[0]);
      if (probe.length === 0) return undefined;
      probe = parentPath;
    }
  };
  const issues: ManifestIssue[] = [];
  for (const issue of parsed.error.issues) {
    const path = issue.path.map(String);
    if (issue.code === "unrecognized_keys") {
      const known = knownKeysAt(AnvilManifest, path);
      for (const key of issue.keys) {
        const pos = locate([...issue.path, key]);
        const suggestion = known ? nearestMatch(key, known) : undefined;
        issues.push({
          path: [...path, key].join("."),
          message: "unknown key",
          ...(pos ?? {}),
          ...(suggestion ? { suggestion } : {}),
        });
      }
      continue;
    }
    const pos = locate(issue.path);
    issues.push({ path: path.join("."), message: issue.message, ...(pos ?? {}) });
  }
  return { ok: false, issues };
}

/**
 * The keys a strict object schema accepts at `path`, walked through optionals,
 * defaults, records, and unions. Undefined when the path does not land on an
 * object (or the walk meets a shape this helper does not know), in which case
 * no suggestion is offered rather than a wrong one.
 */
function knownKeysAt(schema: unknown, path: readonly string[]): string[] | undefined {
  let current: unknown = schema;
  const unwrap = (value: unknown): unknown => {
    let node = value;
    for (let i = 0; i < 8; i++) {
      const def = (node as { def?: { type?: string; innerType?: unknown } } | undefined)?.def;
      if (!def) return node;
      if (def.type === "optional" || def.type === "default" || def.type === "nullable") {
        node = def.innerType;
        continue;
      }
      return node;
    }
    return node;
  };
  for (const segment of path) {
    const node = unwrap(current) as {
      def?: {
        type?: string;
        shape?: Record<string, unknown>;
        valueType?: unknown;
        options?: unknown[];
      };
    };
    const def = node?.def;
    if (!def) return undefined;
    if (def.type === "object" && def.shape) {
      current = def.shape[segment];
      if (current === undefined) return undefined;
      continue;
    }
    if (def.type === "record") {
      current = def.valueType;
      continue;
    }
    if (def.type === "union" && def.options) {
      const objects = def.options.map(unwrap).filter((o) => {
        const d = (o as { def?: { type?: string } }).def;
        return d?.type === "object";
      });
      if (objects.length !== 1) return undefined;
      current = objects[0];
      const shape = (current as { def: { shape: Record<string, unknown> } }).def.shape;
      current = shape[segment];
      if (current === undefined) return undefined;
      continue;
    }
    return undefined;
  }
  const leaf = unwrap(current) as { def?: { type?: string; shape?: Record<string, unknown> } };
  return leaf?.def?.type === "object" && leaf.def.shape ? Object.keys(leaf.def.shape) : undefined;
}

export function parseManifest(text: string): AnvilManifest {
  const result = parseManifestDetailed(text);
  if (result.ok) return result.manifest;
  throw new ManifestParseError(result.issues);
}

/**
 * Manifest entries that matched nothing. `operations`, `capabilities`, and
 * `query_templates` are keyed by operation id, canonical name, or source
 * operation id; a key that matches no operation used to be ignored without a
 * word, so a typo'd id meant the override the reviewer wrote never applied and
 * nothing said so. Every such key is an error, with the nearest real id when
 * one is plausible.
 */
export function unresolvedManifestEntries(
  manifest: AnvilManifest,
  operations: readonly Operation[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const candidates = [
    ...new Set(
      operations.flatMap((op) => [op.id, op.canonicalName, op.sourceRef.operationId ?? ""]),
    ),
  ].filter((c) => c.length > 0);
  for (const key of Object.keys(manifest.operations)) {
    if (operations.some((op) => operationMatchesKey(op, key))) continue;
    const suggestion = nearestMatch(key, candidates);
    diagnostics.push({
      level: "error",
      code: "manifest_operation_unresolved",
      message:
        `Manifest entry operations.${key} matches no operation in this source` +
        (suggestion ? `; did you mean '${suggestion}'?` : ".") +
        " The overrides it declares were not applied.",
    });
  }
  return diagnostics;
}
