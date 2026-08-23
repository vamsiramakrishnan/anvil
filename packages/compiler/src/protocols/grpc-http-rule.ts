/**
 * `google.api.http` — a proto method declaring its own HTTP/JSON mapping.
 *
 * This is the gRPC analogue of `soap:address` in a WSDL: a fact the *source
 * document itself* states about how the service is reached, rather than one an
 * operator has to assert about a deployment. A bare proto genuinely cannot know
 * whether a gateway sits in front of it, which is why an unannotated method
 * still requires `--protocol-facade`. An annotated one has already answered the
 * question — grpc-gateway, Envoy's gRPC-JSON filter, and ESPv2 all read exactly
 * this option to decide which HTTP route to serve — so Anvil reads the same
 * option and calls the same route.
 *
 * The result is that an annotated proto compiles to the REST document it says
 * it is: real verbs, real paths, path and query parameters bound from the
 * request message. Nothing downstream needs a gRPC concept, because on the wire
 * there is no longer anything gRPC about the call.
 *
 * `additional_bindings` are alternate routes to the same RPC. The primary
 * binding is a complete way to call it, so the alternates are not read — an
 * operation is one way to invoke something, and offering an agent four
 * equivalent spellings of one call is how it starts guessing between them.
 */

/** The verbs `HttpRule` can declare, all of which OpenAPI and the runtime speak. */
type HttpVerb = "get" | "put" | "post" | "delete" | "patch";
const VERBS: readonly HttpVerb[] = ["get", "put", "post", "delete", "patch"];

const ANNOTATION = "(google.api.http)";
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A `{...}` group in a path template, e.g. `{name}` or `{parent=projects/*}`. */
const TEMPLATE = /\{([^}]*)\}/g;

interface HttpRule {
  verb: HttpVerb;
  /** The path with each template reduced to its bare field name, which is both
   *  the OpenAPI spelling and what the runtime substitutes into. */
  path: string;
  /** Request-message fields bound into the path, in the order they appear. */
  pathFields: string[];
  /** `*` for the whole message, a field name for that field alone, or
   *  `undefined` when the rule declares no body at all. */
  body: string | undefined;
}

export type HttpRuleOutcome = { ok: true; rule: HttpRule } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `(google.api.http)` value out of protobufjs's `parsedOptions`, which is
 *  an array of single-key objects — one per option written on the method. */
function annotationOf(parsedOptions: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(parsedOptions)) return undefined;
  for (const entry of parsedOptions) {
    if (!isRecord(entry)) continue;
    const value = entry[ANNOTATION];
    if (isRecord(value)) return value;
  }
  return undefined;
}

/**
 * Rewrite a path template into its OpenAPI spelling, or say why it cannot be.
 *
 * Two shapes are declined, both because the runtime percent-encodes a path
 * parameter before substituting it (`executor.ts`, `encodeURIComponent`):
 *
 *   - A pattern other than `*` — `{parent=projects/*}`, `{name=books/**}` —
 *     matches a value that *contains* a slash. Percent-encoded, that value
 *     addresses a different resource than the one asked for, so the call would
 *     succeed against the wrong thing rather than fail.
 *   - A dotted field path — `{book.name}` — names a field inside a nested
 *     message, and the runtime binds parameters by top-level name only.
 *
 * Both are expressible and neither is implemented, so they are refused rather
 * than encoded on a guess.
 */
function rewriteTemplate(
  path: string,
): { ok: true; path: string; fields: string[] } | { ok: false; reason: string } {
  const fields: string[] = [];
  let refusal: string | undefined;

  const rewritten = path.replace(TEMPLATE, (whole: string, inner: string) => {
    const eq = inner.indexOf("=");
    const field = eq < 0 ? inner : inner.slice(0, eq);
    const pattern = eq < 0 ? "*" : inner.slice(eq + 1);
    if (field.includes(".")) {
      refusal ??=
        `the path template binds '${field}', a field inside a nested message; ` +
        "Anvil binds path parameters by top-level field name only";
      return whole;
    }
    if (!FIELD_NAME.test(field)) {
      refusal ??= `the path template contains '${whole}', which names no field`;
      return whole;
    }
    if (pattern !== "*") {
      refusal ??=
        `the path template binds '${field}' to the pattern '${pattern}', which matches a ` +
        "value spanning more than one path segment; Anvil percent-encodes a path parameter, " +
        "which would address a different resource rather than fail";
      return whole;
    }
    if (fields.includes(field)) {
      refusal ??= `the path template binds '${field}' more than once`;
      return whole;
    }
    fields.push(field);
    return `{${field}}`;
  });

  if (refusal !== undefined) return { ok: false, reason: refusal };
  return { ok: true, path: rewritten, fields };
}

/**
 * Read the HTTP rule a proto method declares, if it declares one.
 *
 * Returns `undefined` when there is no annotation at all — a different answer
 * from a refusal, and the distinction matters: an unannotated method falls back
 * to gRPC's own coordinate and keeps requiring a declared facade, while an
 * annotated one Anvil declines must refuse outright. A gateway serves the
 * declared route and nothing else, so falling back there would aim the call at
 * a path that provably is not served.
 *
 * `requestFields` is the top-level field names of the request message, or
 * `undefined` when the message could not be resolved (an unresolved import).
 * Without it the bindings cannot be checked, and a mapping Anvil cannot check
 * is one it does not claim.
 */
export function httpRuleOf(
  parsedOptions: unknown,
  requestFields: readonly string[] | undefined,
): HttpRuleOutcome | undefined {
  const annotation = annotationOf(parsedOptions);
  if (!annotation) return undefined;

  if (annotation.custom !== undefined) {
    return {
      ok: false,
      reason:
        "the rule declares a `custom` method kind, which names a verb outside the set " +
        "OpenAPI and the runtime share",
    };
  }

  const declared = VERBS.filter((verb) => typeof annotation[verb] === "string");
  if (declared.length === 0) {
    return { ok: false, reason: "the rule declares no HTTP method and no path" };
  }
  if (declared.length > 1) {
    return {
      ok: false,
      reason: `the rule declares more than one HTTP method (${declared.join(", ")})`,
    };
  }

  const verb = declared[0] as HttpVerb;
  const template = annotation[verb] as string;
  if (!template.startsWith("/")) {
    return { ok: false, reason: `the declared path '${template}' is not absolute` };
  }

  const rewritten = rewriteTemplate(template);
  if (!rewritten.ok) return rewritten;

  if (requestFields === undefined) {
    return {
      ok: false,
      reason:
        "the request message could not be resolved, so the fields the rule binds cannot be " +
        "checked against it",
    };
  }
  for (const field of rewritten.fields) {
    if (!requestFields.includes(field)) {
      return {
        ok: false,
        reason: `the path template binds '${field}', which the request message does not declare`,
      };
    }
  }

  const rawBody = annotation.body;
  if (rawBody !== undefined && typeof rawBody !== "string") {
    return { ok: false, reason: "the rule declares a `body` that is not a field name" };
  }
  const body = rawBody === undefined || rawBody === "" ? undefined : rawBody;
  if (body !== undefined && body !== "*") {
    if (!requestFields.includes(body)) {
      return {
        ok: false,
        reason: `the rule sends '${body}' as the body, which the request message does not declare`,
      };
    }
    if (rewritten.fields.includes(body)) {
      return {
        ok: false,
        reason: `the rule sends '${body}' as the body and also binds it into the path`,
      };
    }
  }

  return { ok: true, rule: { verb, path: rewritten.path, pathFields: rewritten.fields, body } };
}
