import type { Diagnostic } from "@anvil/air";
import { childrenNamed, type XmlElement } from "./xml.js";

/**
 * OData actions, functions, and function imports.
 *
 * Entity sets are only half of an OData service. The other half is the
 * behaviour: `ActivateProduct`, `GetNearestAirport`, `ResetDataSource`. In
 * OData v2 — SAP's dialect, and the one most of the installed base speaks —
 * a `FunctionImport` is how a service exposes anything that is not CRUD, so a
 * compiler that reads only entity sets reads only the nouns.
 *
 * Until now Anvil emitted none of them, and emitted no diagnostic either: an
 * SAP developer compiled `$metadata` and the half of the service that *does*
 * things was simply absent, with nothing to say so. Silence is the worst
 * failure mode here, because the surface looks complete.
 *
 * The effect classification is unusually strong for once. OData *declares* it:
 * a v4 `Function` is required by the specification to be side-effect-free, an
 * `Action` is not, and a v2 `FunctionImport` carries `m:HttpMethod`. So the
 * verb these lower to is read off the document rather than guessed from a name,
 * and ordinary REST classification downstream reaches the right answer with no
 * adapter assertion at all.
 */

/** The OData version, which decides both where operations are declared and how
 *  a parameter value is spelled on the wire. */
export type OdataVersion = "2" | "4";

export interface OdataOperationModel {
  /** The addressable name — the import name, not the underlying function name. */
  name: string;
  verb: "get" | "post";
  /** The coordinate with `{param}` placeholders, literal syntax already applied. */
  path: string;
  /** Parameters bound by substitution into the coordinate. */
  pathParams: OdataParam[];
  /** Parameters carried as a JSON body (a v4 action, and nothing else). */
  bodyParams: OdataParam[];
  returnType: string | undefined;
  /** The entity set the result belongs to, when the document says. */
  entitySet: string | undefined;
}

export interface OdataParam {
  name: string;
  type: string;
  required: boolean;
}

/**
 * What the adapter knows about entity sets, handed in so a *bound* operation
 * can be addressed. A bound action or function is invoked through an entity
 * instance — `/Products('HT-1000')/NS.Activate` — so lowering one needs
 * exactly two facts this module does not otherwise hold: which entity set
 * exposes the binding type, and how that set spells its key segment.
 */
export interface OdataBoundContext {
  /** Local entity type name → the entity sets that expose it. */
  setsByType: Map<string, string[]>;
  /** Local entity type name → the key segment (`('{ID}')`) and its params. */
  keySegmentFor: (typeLocal: string) => { segment: string; params: OdataParam[] } | undefined;
}

/** An attribute read by local name, so a prefix (`m:HttpMethod`, `sap:label`)
 *  does not have to be guessed. `xml.ts` keeps attributes exactly as written. */
function attrLocal(el: XmlElement, local: string): string | undefined {
  for (const [key, value] of Object.entries(el.attrs)) {
    const idx = key.indexOf(":");
    if ((idx >= 0 ? key.slice(idx + 1) : key) === local) return value;
  }
  return undefined;
}

/**
 * OData v2 spells a literal with a type prefix or suffix; v4 dropped almost all
 * of them. Both quote a string.
 *
 * This is applied at compile time, into the path, so the quote characters are
 * literal coordinate text and only the *value* is percent-encoded when the
 * runtime substitutes it. That is the same move the gRPC adapter makes with a
 * declared HTTP rule: protocol syntax belongs in the compiled coordinate, not
 * in a codec every surface would need its own copy of.
 */
function literalTemplate(type: string, placeholder: string, version: OdataVersion): string {
  const edm = type.startsWith("Edm.") ? type.slice(4) : type;
  const quoted = `'${placeholder}'`;
  if (edm === "String") return quoted;
  if (version === "4") {
    // v4 writes every other primitive bare, including Guid and the date family.
    return placeholder;
  }
  switch (edm) {
    case "Guid":
      return `guid${quoted}`;
    case "DateTime":
      return `datetime${quoted}`;
    case "Time":
      return `time${quoted}`;
    case "Binary":
      return `binary${quoted}`;
    case "Int64":
      return `${placeholder}L`;
    case "Decimal":
      return `${placeholder}M`;
    case "Single":
      return `${placeholder}f`;
    case "Double":
      return `${placeholder}d`;
    default:
      return placeholder;
  }
}

/** `<Parameter>` children that are genuinely inputs. v2 marks direction with
 *  `Mode`; anything not explicitly `Out` is an input. */
function parametersOf(el: XmlElement, skip?: string): OdataParam[] {
  const out: OdataParam[] = [];
  for (const param of childrenNamed(el, "Parameter")) {
    const name = param.attrs.Name;
    if (!name || name === skip) continue;
    if ((attrLocal(param, "Mode") ?? "In").toLowerCase() === "out") continue;
    out.push({
      name,
      type: param.attrs.Type ?? "Edm.String",
      required: (attrLocal(param, "Nullable") ?? "true") === "false",
    });
  }
  return out;
}

/** `Version="4.0"` on the EDMX root, with a v4-only element as the fallback
 *  signal for a document that omits it. */
export function odataVersion(root: XmlElement, schemas: readonly XmlElement[]): OdataVersion {
  const declared = attrLocal(root, "Version");
  if (declared?.startsWith("4")) return "4";
  if (declared?.startsWith("1")) return "2";
  const hasV4Only = schemas.some(
    (s) => childrenNamed(s, "Action").length > 0 || childrenNamed(s, "Function").length > 0,
  );
  return hasV4Only ? "4" : "2";
}

function pathFor(name: string, params: OdataParam[], version: OdataVersion): string {
  if (params.length === 0) return version === "4" ? `/${name}()` : `/${name}`;
  if (version === "4") {
    // v4 addresses a function's arguments inline, inside the resource segment.
    const inline = params
      .map((p) => `${p.name}=${literalTemplate(p.type, `{${p.name}}`, version)}`)
      .join(",");
    return `/${name}(${inline})`;
  }
  // v2 carries them as query options, still in OData literal syntax.
  const query = params
    .map((p) => `${p.name}=${literalTemplate(p.type, `{${p.name}}`, version)}`)
    .join("&");
  return `/${name}?${query}`;
}

/**
 * Every invocable operation the container exposes.
 *
 * A *bound* operation is addressed through an entity instance —
 * `/Products('HT-1000')/NS.Activate` — so it lowers whenever the address can
 * be constructed without guessing: the binding type is exposed by exactly one
 * entity set, and that set has a key. The instance's key becomes an ordinary
 * required path parameter, the same one the entity set's own GET already asks
 * for. What still declines, each with its reason: a collection-bound
 * operation, a binding type no entity set exposes, and a binding type exposed
 * by several sets (either address would be a guess).
 */
export function collectOdataOperations(
  schemas: readonly XmlElement[],
  version: OdataVersion,
  diagnostics?: Diagnostic[],
  bound?: OdataBoundContext,
): OdataOperationModel[] {
  const found: OdataOperationModel[] = [];
  const seen = new Set<string>();

  // v4 declares the signature at schema level and exposes it through an import.
  const byQualifiedName = new Map<string, { el: XmlElement; kind: "action" | "function" }>();
  for (const schema of schemas) {
    const ns = schema.attrs.Namespace ?? "";
    for (const kind of ["Action", "Function"] as const) {
      for (const el of childrenNamed(schema, kind)) {
        const name = el.attrs.Name;
        if (!name) continue;
        const entry = { el, kind: kind === "Action" ? ("action" as const) : ("function" as const) };
        // Overloads share a name; the unbound one is what an import addresses.
        if (attrLocal(el, "IsBound") === "true") continue;
        byQualifiedName.set(`${ns}.${name}`, entry);
        byQualifiedName.set(name, entry);
      }
    }
  }

  const declineBound = (name: string, what: string, reason: string): void => {
    diagnostics?.push({
      level: "warning",
      code: "odata_bound_operation_skipped",
      path: name,
      message:
        `Anvil did not emit OData ${what} '${name}': ${reason} ` +
        `Model it in an Anvil manifest if the service needs it.`,
    });
  };

  for (const schema of schemas) {
    const ns = schema.attrs.Namespace ?? "";
    for (const kind of ["Action", "Function"] as const) {
      for (const el of childrenNamed(schema, kind)) {
        if (attrLocal(el, "IsBound") !== "true" || !el.attrs.Name) continue;
        const name = el.attrs.Name;
        const what = kind.toLowerCase();
        // The binding parameter is the first one, by specification; its type
        // names what the operation hangs off.
        const bindingParam = childrenNamed(el, "Parameter")[0];
        const bindingType = bindingParam?.attrs.Type ?? "";
        if (/^Collection\(/.test(bindingType)) {
          declineBound(
            name,
            what,
            `it is bound to a collection (${bindingType}), and Anvil lowers instance-bound ` +
              `operations only.`,
          );
          continue;
        }
        const typeLocal = bindingType.split(".").pop() ?? "";
        const sets = bound?.setsByType.get(typeLocal) ?? [];
        if (sets.length === 0) {
          declineBound(
            name,
            what,
            `it is bound to '${bindingType}', which no entity set in this container exposes, ` +
              `so there is no address to reach an instance through.`,
          );
          continue;
        }
        if (sets.length > 1) {
          declineBound(
            name,
            what,
            `it is bound to '${bindingType}', which ${sets.length} entity sets expose ` +
              `(${sets.join(", ")}) — either address would be a guess.`,
          );
          continue;
        }
        const keyed = bound?.keySegmentFor(typeLocal);
        if (!keyed) {
          declineBound(
            name,
            what,
            `it is bound to '${bindingType}', whose entity type declares no key, so an ` +
              `instance cannot be addressed.`,
          );
          continue;
        }

        const setName = sets[0] as string;
        const params = parametersOf(el, bindingParam?.attrs.Name);
        const isAction = kind === "Action";
        const qualified = ns ? `${ns}.${name}` : name;
        // v4 addresses a bound function's arguments inline after the qualified
        // name; a bound action takes them as a JSON body. Both hang off the
        // instance: /Set(key)/Namespace.Operation .
        const inline = isAction
          ? ""
          : `(${params
              .map((p) => `${p.name}=${literalTemplate(p.type, `{${p.name}}`, "4")}`)
              .join(",")})`;
        const id = seen.has(name) ? `${setName}_${name}` : name;
        if (seen.has(id)) continue;
        seen.add(id);
        found.push({
          name: id,
          verb: isAction ? "post" : "get",
          path: `/${setName}${keyed.segment}/${qualified}${inline}`,
          pathParams: isAction ? [...keyed.params] : [...keyed.params, ...params],
          bodyParams: isAction ? params : [],
          returnType: childrenNamed(el, "ReturnType")[0]?.attrs.Type,
          entitySet: setName,
        });
      }
    }

    for (const container of childrenNamed(schema, "EntityContainer")) {
      // v4: ActionImport / FunctionImport point at a declared signature.
      for (const kind of ["ActionImport", "FunctionImport"] as const) {
        for (const imported of childrenNamed(container, kind)) {
          const name = imported.attrs.Name;
          if (!name || seen.has(name)) continue;

          const target =
            kind === "ActionImport"
              ? byQualifiedName.get(imported.attrs.Action ?? "")
              : byQualifiedName.get(imported.attrs.Function ?? "");

          if (target) {
            // v4 — the signature lives on the referenced Action/Function.
            const params = parametersOf(target.el);
            const isAction = target.kind === "action";
            seen.add(name);
            found.push({
              name,
              verb: isAction ? "post" : "get",
              path: isAction ? `/${name}` : pathFor(name, params, "4"),
              pathParams: isAction ? [] : params,
              bodyParams: isAction ? params : [],
              returnType: childrenNamed(target.el, "ReturnType")[0]?.attrs.Type,
              entitySet: imported.attrs.EntitySet,
            });
            continue;
          }

          // v2 — the FunctionImport carries its own signature and verb.
          if (kind !== "FunctionImport") continue;
          const params = parametersOf(imported);
          // `m:HttpMethod` is the document's own statement of the verb. Absent,
          // the operation stays a mutation: an unproven side effect is treated
          // as present, never as absent.
          const declaredVerb = attrLocal(imported, "HttpMethod")?.toUpperCase();
          const verb = declaredVerb === "GET" ? "get" : "post";
          if (declaredVerb === undefined) {
            diagnostics?.push({
              level: "warning",
              code: "odata_function_import_verb_unstated",
              path: name,
              message:
                `OData FunctionImport '${name}' declares no m:HttpMethod, so Anvil cannot tell ` +
                `whether it reads or writes. It is treated as a mutation — unsafe until ` +
                `reviewed — rather than assumed safe.`,
            });
          }
          seen.add(name);
          found.push({
            name,
            verb,
            path: pathFor(name, params, version),
            pathParams: params,
            bodyParams: [],
            returnType: imported.attrs.ReturnType,
            entitySet: imported.attrs.EntitySet,
          });
        }
      }
    }
  }

  return found;
}
