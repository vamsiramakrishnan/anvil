/**
 * Union alternatives: how a materialized `oneOf`/`anyOf` member keeps the
 * name it was declared under, and how a reviewer narrows a union input to one
 * of its alternatives (manifest `params.<input>.one_of`).
 *
 * Some sources type an input as a union whose alternatives all accept the
 * same values. Confluence's v2 page write types `body` as
 * `oneOf[PageBodyWrite, PageNestedBodyWrite]`, and both are open objects, so
 * a strict `oneOf` refuses every body: each value is valid under both. The
 * service accepts `{"representation": "storage", "value": "..."}`. Narrowing
 * picks the alternative the service actually reads and can only tighten it:
 * a narrowed property keeps a subset of the values it allowed, a required
 * list only grows, and extra properties can only be closed.
 */

/**
 * The keyword a materialized union alternative carries its component name
 * under. Only `oneOf`/`anyOf` members reached by `$ref` are stamped: they are
 * the one place a reviewer must name a branch the `$ref`-free schema no longer
 * names.
 */
export const COMPONENT_NAME_KEYWORD = "x-anvil-component";

const UNION_KEYWORDS = ["oneOf", "anyOf"] as const;

type Schema = Record<string, unknown>;

function isObject(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function componentName(ref: unknown): string | undefined {
  if (!isObject(ref) || typeof ref.$ref !== "string") return undefined;
  return ref.$ref.match(/^#\/components\/schemas\/(.+)$/)?.[1];
}

/**
 * Stamp each `oneOf`/`anyOf` member of `resolved` that `source` declared as a
 * `$ref` with its component name. Members are replaced by copies: a resolved
 * body may be the memoized value another reference shares.
 */
export function stampAlternatives(source: unknown, resolved: Schema): void {
  if (!isObject(source)) return;
  for (const keyword of UNION_KEYWORDS) {
    const declared = source[keyword];
    const members = resolved[keyword];
    if (!Array.isArray(declared) || !Array.isArray(members)) continue;
    resolved[keyword] = members.map((member, i) => {
      const name = componentName(declared[i]);
      return name !== undefined && isObject(member)
        ? { ...member, [COMPONENT_NAME_KEYWORD]: name }
        : member;
    });
  }
}

/** A JSON scalar a narrowed property may be limited to. */
export type AlternativeValue = string | number | boolean | null;

/** The manifest's narrowing of one union input; see `ManifestParams`. */
export interface AlternativeNarrowing {
  /** The alternative, by component name (or a `$ref` whose tail is one), title, or branch index. */
  one_of: string | number;
  /** Limit a property the alternative declares to a subset of the values it allows. */
  properties?: Record<string, { enum: AlternativeValue[] }>;
  /** Properties of the alternative that must be present. Only ever added to. */
  required?: string[];
  /** Close the alternative to the properties it declares. */
  additional_properties?: false;
}

export type Narrowed =
  | { ok: true; schema: Schema; alternative: string }
  | { ok: false; reason: string };

/** Keywords that describe a value rather than constrain it; the input's own copy wins. */
const DESCRIPTIVE = new Set(["title", "description", "deprecated", "readOnly", "writeOnly"]);

const canon = (value: unknown) => JSON.stringify(value);

function describe(keyword: string, index: number, branch: Schema): string {
  const name = branch[COMPONENT_NAME_KEYWORD] ?? branch.title;
  return `${keyword}[${index}]${typeof name === "string" ? ` (${name})` : ""}`;
}

function pick(
  branches: unknown[],
  keyword: string,
  selector: string | number,
): { index: number; branch: Schema } | { reason: string } {
  const labels = branches.map((b, i) =>
    isObject(b) ? describe(keyword, i, b) : `${keyword}[${i}]`,
  );
  const offered = `it offers ${labels.join(", ")}`;
  if (typeof selector === "number") {
    const branch = branches[selector];
    return isObject(branch)
      ? { index: selector, branch }
      : { reason: `the union has no alternative ${selector}; ${offered}` };
  }
  const wanted = selector.split("/").pop() ?? selector;
  const matches = branches
    .map((branch, index) => ({ index, branch }))
    .filter(
      (m): m is { index: number; branch: Schema } =>
        isObject(m.branch) &&
        (m.branch[COMPONENT_NAME_KEYWORD] === wanted || m.branch.title === wanted),
    );
  const [only, ...rest] = matches;
  if (!only) return { reason: `the union has no alternative named '${wanted}'; ${offered}` };
  if (rest.length > 0) {
    return { reason: `more than one alternative is named '${wanted}'; name it by index instead` };
  }
  return only;
}

const TYPE_OF: Record<string, (v: AlternativeValue) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  null: (v) => v === null,
};

/** Whether the property schema already admits `value`: narrowing may never add one. */
function admits(property: Schema, value: AlternativeValue): boolean {
  if (Array.isArray(property.enum) && !property.enum.some((e) => canon(e) === canon(value))) {
    return false;
  }
  if ("const" in property && canon(property.const) !== canon(value)) return false;
  const types = Array.isArray(property.type) ? property.type : [property.type];
  const declared = types.filter((t): t is string => typeof t === "string");
  if (value === null && property.nullable === true) return true;
  return declared.length === 0 || declared.some((t) => TYPE_OF[t]?.(value) ?? false);
}

function tighten(
  branch: Schema,
  narrowing: AlternativeNarrowing,
): { schema: Schema } | { reason: string } {
  const out: Schema = { ...branch };
  const declared = isObject(branch.properties) ? branch.properties : {};
  const narrowedProps: Schema = { ...declared };
  for (const [name, { enum: values }] of Object.entries(narrowing.properties ?? {})) {
    const property = declared[name];
    if (!isObject(property)) {
      return { reason: `the alternative declares no property '${name}' to narrow` };
    }
    const widened = values.filter((value) => !admits(property, value));
    if (widened.length > 0) {
      return {
        reason:
          `'${name}' would admit ${widened.map(canon).join(", ")}, which the alternative ` +
          "does not allow; a narrowing may only remove values",
      };
    }
    narrowedProps[name] = { ...property, enum: [...values] };
  }
  if (Object.keys(narrowing.properties ?? {}).length > 0) out.properties = narrowedProps;
  if (narrowing.required) {
    const unknown = narrowing.required.filter((name) => !isObject(declared[name]));
    if (unknown.length > 0) {
      return {
        reason: `the alternative declares no ${unknown.map((n) => `'${n}'`).join(", ")} to require`,
      };
    }
    const existing = Array.isArray(branch.required) ? (branch.required as string[]) : [];
    out.required = [...new Set([...existing, ...narrowing.required])];
  }
  if (narrowing.additional_properties === false) out.additionalProperties = false;
  return { schema: out };
}

/**
 * Narrow a union schema to one alternative. The union's own keywords stay;
 * where one would contradict the alternative's they are kept side by side
 * (`allOf`) rather than one overwriting the other, so nothing either side
 * required is dropped.
 */
export function narrowToAlternative(schema: Schema, narrowing: AlternativeNarrowing): Narrowed {
  const keyword = UNION_KEYWORDS.find((k) => Array.isArray(schema[k]));
  if (!keyword) return { ok: false, reason: "the input is not a oneOf/anyOf union" };
  const picked = pick(schema[keyword] as unknown[], keyword, narrowing.one_of);
  if ("reason" in picked) return { ok: false, reason: picked.reason };
  const tightened = tighten(picked.branch, narrowing);
  if ("reason" in tightened) return { ok: false, reason: tightened.reason };
  const branch = tightened.schema;

  const { [keyword]: _union, discriminator: _discriminator, ...siblings } = schema;
  const clash = Object.keys(branch).some(
    (key) =>
      key in siblings &&
      !DESCRIPTIVE.has(key) &&
      !key.startsWith("x-") &&
      canon(siblings[key]) !== canon(branch[key]),
  );
  const merged = clash
    ? {
        ...siblings,
        allOf: [...(Array.isArray(siblings.allOf) ? siblings.allOf : []), branch],
      }
    : { ...branch, ...siblings };
  return { ok: true, schema: merged, alternative: describe(keyword, picked.index, picked.branch) };
}
