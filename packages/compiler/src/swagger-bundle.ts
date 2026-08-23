import { posix } from "node:path";

/**
 * Fold a multi-file Swagger 2.0 source into one self-contained document.
 *
 * `swagger2openapi` owns the whole 2.0 field mapping and cannot follow an
 * external file, which is why a 2.0 entrypoint spanning files used to be
 * rejected outright. The fix is to hand it a document with nothing left to
 * follow.
 *
 * Deliberately a *bundler* and not a dereferencer. Resolving every `$ref` would
 * also inline the internal ones, and that breaks two things at once: a
 * self-referential definition (`Widget.children: [Widget]`) becomes a genuine
 * cycle the converter cannot walk, and a definition used twice becomes the same
 * object at two positions, which the converter reads as a YAML anchor and
 * refuses. Both are artefacts of over-resolving. Only *external* references are
 * pulled in — each one lands in the entrypoint's own `definitions` (or
 * `parameters`, or `responses`) under a name, and the reference is rewritten to
 * point there. Internal references are left exactly as the author wrote them,
 * so recursion stays a reference and nothing is ever shared or duplicated.
 */

export interface LoadedFile {
  isEntrypoint?: boolean;
  filename?: string | null;
  dir?: string;
  specification?: unknown;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve a JSON Pointer (`/definitions/Widget`) against a document. */
function atPointer(document: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return document;
  let current: unknown = document;
  for (const raw of pointer.replace(/^\//, "").split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * The file an external reference names, resolved against the file that wrote
 * it. Tries the joined path, then the path verbatim, then the bare basename —
 * the same ladder `snapshotImportResolver` uses, so a snapshot that preserves
 * directory structure and one that carries files flat both work.
 */
function fileFor(
  files: Map<string, LoadedFile>,
  fromFile: string,
  target: string,
): LoadedFile | undefined {
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), target));
  const candidates = [joined, posix.normalize(target), target, target.split("/").pop() ?? target];
  for (const candidate of candidates) {
    const hit = files.get(candidate) ?? files.get(`./${candidate}`);
    if (hit) return hit;
  }
  return undefined;
}

/** Where a pointer's target belongs in a Swagger 2.0 document. Anything that is
 *  not a recognised 2.0 section is filed under `definitions`, which is the only
 *  section whose members are freely referenceable schemas. */
function sectionFor(pointer: string): string {
  const first = pointer.replace(/^\//, "").split("/")[0];
  return first === "parameters" || first === "responses" ? first : "definitions";
}

export interface BundleResult {
  document: Json;
  /** Files that could not be resolved, named so the caller can refuse loudly. */
  unresolved: string[];
}

export function bundleSwaggerExternalRefs(filesystem: readonly LoadedFile[]): BundleResult {
  const entry = filesystem.find((f) => f.isEntrypoint);
  if (!entry || !isRecord(entry.specification)) {
    return { document: {}, unresolved: [] };
  }
  // The entrypoint is copied rather than mutated: a caller's snapshot document
  // is shared state, and a bundler that edits it in place would make a second
  // compile of the same source see a different document than the first.
  const document = structuredClone(entry.specification) as Json;

  const files = new Map<string, LoadedFile>();
  for (const file of filesystem) {
    if (typeof file.filename === "string") files.set(posix.normalize(file.filename), file);
  }

  const unresolved = new Set<string>();
  /** `file#pointer` → the name it was given, so a definition pulled in twice —
   *  or one that refers back to itself — is inlined once. */
  const placed = new Map<string, string>();

  /** The section object in the entrypoint, created on first use. */
  const bucketFor = (section: string): Json => {
    const existing = document[section];
    if (isRecord(existing)) return existing;
    const created: Json = {};
    document[section] = created;
    return created;
  };

  const nameFor = (section: string, pointer: string): string => {
    const base = pointer.split("/").filter(Boolean).pop() ?? "External";
    const bucket = bucketFor(section);
    if (bucket[base] === undefined) return base;
    // Taken by something else: suffix until free, deterministically.
    let n = 2;
    while (bucket[`${base}${n}`] !== undefined) n += 1;
    return `${base}${n}`;
  };

  /** Rewrite every external `$ref` inside `node`, which was written in `origin`. */
  const walk = (node: unknown, origin: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, origin);
      return;
    }
    if (!isRecord(node)) return;

    const ref = node.$ref;
    if (typeof ref === "string" && !ref.startsWith("#")) {
      const hash = ref.indexOf("#");
      const target = hash >= 0 ? ref.slice(0, hash) : ref;
      const pointer = hash >= 0 ? ref.slice(hash + 1) : "";
      const file = fileFor(files, origin, target);
      const resolvedName = posix.normalize(posix.join(posix.dirname(origin), target));
      const cacheKey = `${resolvedName}#${pointer}`;

      const already = placed.get(cacheKey);
      if (already !== undefined) {
        node.$ref = already;
        return;
      }
      if (!file || !isRecord(file.specification)) {
        unresolved.add(target);
        return;
      }
      const value = atPointer(file.specification, pointer);
      if (value === undefined) {
        unresolved.add(ref);
        return;
      }

      const section = sectionFor(pointer);
      const name = nameFor(section, pointer);
      const bucket = bucketFor(section);
      // Record the name *before* walking the copy, so a definition that refers
      // back to itself resolves to the name already being assigned instead of
      // recursing forever.
      placed.set(cacheKey, `#/${section}/${name}`);
      const copy = structuredClone(value);
      bucket[name] = copy;
      node.$ref = `#/${section}/${name}`;
      // The copy's own references were written relative to the file it came
      // from, not to the entrypoint.
      walk(copy, resolvedName);
      return;
    }

    for (const value of Object.values(node)) walk(value, origin);
  };

  walk(document, typeof entry.filename === "string" ? entry.filename : "./root.yaml");
  return { document, unresolved: [...unresolved] };
}
