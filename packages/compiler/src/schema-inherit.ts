/**
 * Inheritance-aware shaping for `materializeSchema` when `inheritAllOf` is on
 * (see decycle.ts and profile.ts).
 */

export function withoutDiscriminatorMapping(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const discriminator = (value as Record<string, unknown>).discriminator;
  if (discriminator === null || typeof discriminator !== "object") return value;
  if (!("mapping" in discriminator)) return value;
  const { mapping: _mapping, ...rest } = discriminator as Record<string, unknown>;
  return { ...(value as Record<string, unknown>), discriminator: rest };
}

/** Keys an `allOf` member may carry and still merge into one object schema. */
const MERGEABLE_MEMBER_KEYS = new Set([
  "type",
  "title",
  "description",
  "properties",
  "required",
  "discriminator",
]);

/**
 * Merge an inheritance `allOf` (every member a plain object schema: type,
 * properties, required, and annotations only) into one object schema. Graph's
 * `user` becomes one object holding `entity`'s, `directoryObject`'s, and its
 * own properties, which is what a body flattener, a pagination classifier, or
 * a response synthesizer can read. A property two members declare differently keeps
 * both as `allOf`, so nothing is loosened. Any other shape is left unmerged.
 */
export function flattenInheritance(
  schema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const { allOf, ...own } = schema;
  // The schema's own keys merge like one more member, after the inherited ones.
  const members = [...(allOf as unknown[]), own];
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  let title: unknown;
  let description: unknown;
  for (const member of members) {
    if (member === null || typeof member !== "object" || Array.isArray(member)) return undefined;
    const m = member as Record<string, unknown>;
    if (Object.keys(m).some((key) => !MERGEABLE_MEMBER_KEYS.has(key))) return undefined;
    if (m.type !== undefined && m.type !== "object") return undefined;
    const props = m.properties;
    if (props !== undefined) {
      if (props === null || typeof props !== "object" || Array.isArray(props)) return undefined;
      for (const [name, prop] of Object.entries(props as Record<string, unknown>)) {
        const prior = properties[name];
        properties[name] =
          prior === undefined || JSON.stringify(prior) === JSON.stringify(prop)
            ? prop
            : { allOf: [prior, prop] };
      }
    }
    if (Array.isArray(m.required)) {
      for (const r of m.required) if (typeof r === "string") required.add(r);
    }
    title = m.title ?? title;
    description = m.description ?? description;
  }
  return {
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    type: "object",
    properties,
    ...(required.size > 0 ? { required: [...required] } : {}),
  };
}
