import type { Capability, Operation } from "@anvil/air";
import { snakeCase } from "@anvil/air";

/**
 * Capability discovery — the pass that turns a flat list of operations into the
 * primary abstraction agents reason about. It groups operations into business
 * capabilities and stamps each operation with its `capabilityId`.
 *
 * The grouping signal, in order of trust:
 *   1. OpenAPI **tags** (declared in the spec) — highest confidence.
 *   2. the derived **resource** noun — inferred, lower confidence.
 *   3. the **service** itself — the fallback bucket.
 *
 * Provenance is recorded on each capability (`source` + evidence) so review can
 * see whether a grouping is grounded or merely inferred. Workflow inference is
 * deliberately *not* here: Anvil does not fabricate multi-step business logic it
 * cannot prove (workflows are authored/enriched — see the manifest).
 */
export function discoverCapabilities(serviceId: string, operations: Operation[]): Capability[] {
  const groups = new Map<
    string,
    { source: Capability["source"]; label: string; ops: Operation[] }
  >();

  for (const op of operations) {
    const { key, source, label } = groupFor(serviceId, op);
    const id = `${serviceId}.${snakeCase(key)}`;
    op.capabilityId = id;
    const existing = groups.get(id);
    if (existing) existing.ops.push(op);
    else groups.set(id, { source, label, ops: [op] });
  }

  const capabilities: Capability[] = [];
  for (const [id, group] of groups) {
    const resources = [
      ...new Set(group.ops.map((o) => o.effect.resource).filter((r): r is string => Boolean(r))),
    ].sort();
    const confidence = group.source === "tag" ? 0.9 : group.source === "resource" ? 0.5 : 0.3;
    capabilities.push({
      id,
      displayName: titleCase(group.label),
      description: `${titleCase(group.label)} capability for ${serviceId}.`,
      source: group.source,
      resources,
      operationIds: group.ops.map((o) => o.id).sort(),
      workflowIds: [],
      intentExamples: intentExamples(group.label, group.ops),
      state: capabilityState(group.ops),
      evidence: {
        items: [
          {
            kind: group.source === "tag" ? "spec" : "inferred",
            note:
              group.source === "tag"
                ? `Grouped by OpenAPI tag "${group.label}".`
                : group.source === "resource"
                  ? `Inferred from the "${group.label}" resource.`
                  : "Fallback service-level grouping.",
            confidence,
          },
        ],
        confidence,
      },
    });
  }

  return capabilities.sort((a, b) => a.id.localeCompare(b.id));
}

function groupFor(
  serviceId: string,
  op: Operation,
): { key: string; source: Capability["source"]; label: string } {
  const tag = op.tags[0];
  if (tag) return { key: tag, source: "tag", label: tag };
  if (op.effect.resource)
    return { key: op.effect.resource, source: "resource", label: op.effect.resource };
  return { key: serviceId, source: "service", label: serviceId };
}

/** A capability's state summarizes its members: approved if any member is live. */
function capabilityState(ops: Operation[]): Capability["state"] {
  if (ops.some((o) => o.state === "approved")) return "approved";
  if (ops.every((o) => o.state === "blocked")) return "blocked";
  if (ops.some((o) => o.state === "review_required")) return "review_required";
  return "generated";
}

function intentExamples(label: string, ops: Operation[]): string[] {
  const noun = titleCase(label).toLowerCase();
  const examples = [`work with ${noun}`, `manage ${noun}`];
  const first = ops.find((o) => o.skill.intentExamples[0])?.skill.intentExamples[0];
  if (first) examples.push(first);
  return examples;
}

const titleCase = (s: string): string =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
