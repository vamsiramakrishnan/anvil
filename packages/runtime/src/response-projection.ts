import type { AgentProjection } from "@anvil/air";

type JsonObject = Record<string, unknown>;
type PathTree = Map<string, PathTree>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function treeFor(paths: string[]): PathTree {
  const root: PathTree = new Map();
  for (const path of paths) {
    let current = root;
    for (const segment of path.split(".")) {
      const next = current.get(segment) ?? new Map<string, PathTree>();
      current.set(segment, next);
      current = next;
    }
  }
  return root;
}

function select(value: unknown, tree: PathTree): unknown {
  if (Array.isArray(value)) return value.map((entry) => select(entry, tree));
  if (!isObject(value)) return value;
  const selected: JsonObject = {};
  for (const [key, children] of tree) {
    if (!Object.hasOwn(value, key)) continue;
    selected[key] =
      children.size === 0 ? structuredClone(value[key]) : select(value[key], children);
  }
  return selected;
}

function removeAt(value: unknown, path: readonly string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) removeAt(entry, path);
    return;
  }
  if (!isObject(value) || path.length === 0) return;
  const [head, ...tail] = path;
  if (!head) return;
  if (tail.length === 0) {
    delete value[head];
    return;
  }
  removeAt(value[head], tail);
}

function forEachParent(
  value: unknown,
  path: readonly string[],
  visit: (parent: JsonObject) => void,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) forEachParent(entry, path, visit);
    return;
  }
  if (!isObject(value)) return;
  if (path.length === 0) {
    visit(value);
    return;
  }
  const [head, ...tail] = path;
  if (head) forEachParent(value[head], tail, visit);
}

/**
 * Apply AIR's safe default response view. The function can only copy, remove,
 * or rename existing JSON fields. It cannot evaluate code, invent values, or
 * mutate the transport response passed by the caller.
 */
export function applyAgentProjection(
  data: unknown,
  projection: AgentProjection | undefined,
): unknown {
  if (!projection) return data;
  const projected = projection.include
    ? select(data, treeFor(projection.include))
    : structuredClone(data);

  for (const path of projection.exclude ?? []) removeAt(projected, path.split("."));

  for (const [source, destination] of Object.entries(projection.rename ?? {})) {
    const sourceParts = source.split(".");
    const destinationParts = destination.split(".");
    const sourceLeaf = sourceParts.pop();
    const destinationLeaf = destinationParts.pop();
    if (!sourceLeaf || !destinationLeaf) continue;
    // AgentProjection validation requires identical parents. Keeping this
    // guard makes the runtime safe for embedders that bypass AIR parsing.
    if (sourceParts.join(".") !== destinationParts.join(".")) continue;
    forEachParent(projected, sourceParts, (parent) => {
      if (!Object.hasOwn(parent, sourceLeaf) || Object.hasOwn(parent, destinationLeaf)) return;
      parent[destinationLeaf] = parent[sourceLeaf];
      delete parent[sourceLeaf];
    });
  }
  return projected;
}
