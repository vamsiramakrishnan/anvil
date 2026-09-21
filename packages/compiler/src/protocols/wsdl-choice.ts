/**
 * `xsd:choice` → JSON Schema.
 *
 * A choice says "exactly one of these branches". Flattening its members into
 * co-required siblings, which is what the adapter used to do, turned that into
 * "all of these at once": a request schema an agent could satisfy only by
 * sending every branch, which no SOAP service accepts. The lowering here keeps
 * every member as an optional property — so each one is still visible and
 * typed — and adds a `oneOf` whose alternatives require one branch apiece and
 * mark the other branches' members absent, so a request that carries two
 * branches, or none of a required choice, is refused by the schema before it
 * is ever encoded.
 *
 * Only what is directly expressible is expressed. A branch that is itself a
 * `sequence` requires that sequence's non-optional elements, and expands into
 * one alternative per combination when it holds a choice of its own, so the
 * inner exactly-one rule survives; a nested `choice` directly under a choice
 * is flattened into the outer one's branches, since "one of (a | one of (b, c))"
 * is "one of (a, b, c)"; a `choice` with `minOccurs="0"`, or a branch whose
 * only element is itself optional, admits the empty case. `maxOccurs` on the
 * choice itself is not modelled — the members keep their own cardinality.
 */
import { localName, type XmlElement } from "./xml.js";

type JsonSchemaLike = Record<string, unknown>;

export interface ChoiceLowering {
  /** Every `<element>` that sits under a choice: optional, never co-required. */
  members: Set<XmlElement>;
  /** One `{ oneOf }` constraint per choice found at particle level. */
  constraints: JsonSchemaLike[];
  /** The member names of each choice, in document order, for the diagnostic. */
  choices: string[][];
}

/** One branch of a choice: what it may carry, and what it must. */
interface Branch {
  carries: string[];
  requires: string[];
}

/** Containers a particle walk descends through; an `<element>` ends it. */
const PARTICLE_CONTAINERS = new Set([
  "sequence",
  "all",
  "group",
  "complexContent",
  "simpleContent",
  "extension",
  "restriction",
]);

/** The choices that belong to this complexType, not to an element nested in it. */
function particleChoices(ct: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      const kind = localName(child.tag);
      if (kind === "choice") out.push(child);
      else if (PARTICLE_CONTAINERS.has(kind)) walk(child);
    }
  };
  walk(ct);
  return out;
}

function memberName(el: XmlElement): string | undefined {
  if (el.attrs.name) return localName(el.attrs.name);
  if (el.attrs.ref) return localName(el.attrs.ref);
  return undefined;
}

/**
 * How many alternatives one sequence branch may expand into before the
 * lowering stops enumerating. Nested choices multiply, and a schema with
 * thousands of alternatives helps no reader; past the cap the sequence keeps
 * its own requirements and carries the inner members as optional, which is
 * permissive rather than wrong, and the diagnostic still names the choice.
 */
const MAX_SEQUENCE_ALTERNATIVES = 64;

/**
 * A sequence/all branch, as one alternative per combination it admits.
 *
 * A nested choice cannot ride along as a bag of optional members: that
 * accepts both none of them and all of them, while the XSD admits exactly
 * one. Expanding the sequence into one alternative per inner branch keeps
 * that rule — `constraintFor` then excludes the inner members each
 * alternative did not pick — so a request carrying two of them, or none where
 * the choice is required, is refused by the schema instead of being encoded
 * into SOAP the service rejects.
 */
function sequenceBranches(seq: XmlElement, members: Set<XmlElement>): Branch[] {
  let alternatives: Branch[] = [{ carries: [], requires: [] }];
  let capped = false;
  const combine = (variants: readonly Branch[]): void => {
    if (variants.length === 0) return;
    if (alternatives.length * variants.length > MAX_SEQUENCE_ALTERNATIVES) {
      capped = true;
      // Keep every member visible, require nothing extra: the permissive case.
      const carried = variants.flatMap((v) => v.carries);
      alternatives = alternatives.map((base) => ({
        carries: [...base.carries, ...carried],
        requires: [...base.requires],
      }));
      return;
    }
    alternatives = alternatives.flatMap((base) =>
      variants.map((variant) => ({
        carries: [...base.carries, ...variant.carries],
        requires: [...base.requires, ...variant.requires],
      })),
    );
  };
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      const kind = localName(child.tag);
      if (kind === "element") {
        members.add(child);
        const name = memberName(child);
        if (!name) continue;
        combine([{ carries: [name], requires: child.attrs.minOccurs === "0" ? [] : [name] }]);
      } else if (kind === "choice") {
        const inner = branchesOf(child, members);
        if (inner.length === 0) continue;
        // An optional inner choice also admits picking none of it.
        combine(child.attrs.minOccurs === "0" ? [...inner, { carries: [], requires: [] }] : inner);
      } else if (kind === "sequence" || kind === "all") {
        walk(child);
      }
    }
  };
  walk(seq);
  if (capped) return [{ carries: alternatives.flatMap((a) => a.carries), requires: [] }];
  return alternatives;
}

function branchesOf(choice: XmlElement, members: Set<XmlElement>): Branch[] {
  const out: Branch[] = [];
  for (const child of choice.children) {
    const kind = localName(child.tag);
    if (kind === "element") {
      members.add(child);
      const name = memberName(child);
      if (!name) continue;
      out.push({ carries: [name], requires: child.attrs.minOccurs === "0" ? [] : [name] });
    } else if (kind === "choice") {
      out.push(...branchesOf(child, members));
    } else if (kind === "sequence" || kind === "all") {
      out.push(...sequenceBranches(child, members));
    }
    // `any` and `group ref` are not lowered; there is no element to name.
  }
  return out;
}

/**
 * "This property must be absent", as the one spelling of the false schema that
 * survives the trip to a served surface. The obvious encoding — a sibling
 * `not: { anyOf: [{ required: [other] }, ...] }` — does not: Zod's JSON Schema
 * importer rejects `not` outright except for this exact `{ not: {} }` form, so
 * an alternative carrying one takes the generated MCP server down at tool
 * registration; and the bundler's depth bound truncates the `required` arrays
 * nested that far down to `[]`, which turns "must not carry the others" into a
 * branch nothing can satisfy. Marking the excluded members absent keeps the
 * constraint shallow, inside `properties` where a reader already looks, and
 * degrades to merely permissive if it is ever truncated.
 */
const absent = (): JsonSchemaLike => ({ not: {} });

const excluding = (names: readonly string[]): JsonSchemaLike =>
  Object.fromEntries(names.map((name) => [name, absent()]));

/**
 * The `oneOf` for one choice. When every branch is a single required element
 * the alternatives are simply `{ required: [member] }` — mutually exclusive
 * under `oneOf` on their own, and the shape a reader expects. Otherwise each
 * alternative also rules out the other branches' members explicitly, which is
 * what keeps "one of (a | b, c)" from accepting `{ a, b }`.
 */
function constraintFor(
  choice: XmlElement,
  branches: readonly Branch[],
): JsonSchemaLike | undefined {
  const named = branches.filter((b) => b.carries.length > 0);
  if (named.length === 0) return undefined;
  const carried = [...new Set(named.flatMap((b) => b.carries))];
  const simple = named.every((b) => b.carries.length === 1 && b.requires.length === 1);
  const alternatives: JsonSchemaLike[] = simple
    ? named.map((b) => ({ required: b.requires }))
    : named.map((b) => {
        const others = carried.filter((name) => !b.carries.includes(name));
        return {
          ...(b.requires.length > 0 ? { required: b.requires } : {}),
          ...(others.length > 0 ? { properties: excluding(others) } : {}),
        };
      });
  const optional = choice.attrs.minOccurs === "0";
  if (optional) alternatives.push({ properties: excluding(carried) });
  return { oneOf: alternatives };
}

/** Lower every particle-level choice of a complexType. */
export function lowerChoices(ct: XmlElement): ChoiceLowering {
  const members = new Set<XmlElement>();
  const constraints: JsonSchemaLike[] = [];
  const choices: string[][] = [];
  for (const choice of particleChoices(ct)) {
    const branches = branchesOf(choice, members);
    const constraint = constraintFor(choice, branches);
    if (!constraint) continue;
    constraints.push(constraint);
    choices.push([...new Set(branches.flatMap((b) => b.carries))]);
  }
  return { members, constraints, choices };
}

/**
 * Attach the constraints to the type's object schema: one choice sits on the
 * schema itself, several are conjoined under `allOf` so each keeps its own
 * exactly-one rule.
 */
export function applyChoiceConstraints(
  schema: JsonSchemaLike,
  constraints: readonly JsonSchemaLike[],
): void {
  if (constraints.length === 1) {
    Object.assign(schema, constraints[0]);
  } else if (constraints.length > 1) {
    schema.allOf = [...constraints];
  }
}
