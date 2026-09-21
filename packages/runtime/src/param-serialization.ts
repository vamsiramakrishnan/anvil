import { type Param, serializeQueryParam, serializeSimpleParam } from "@anvil/air";
import { AnvilError } from "./errors.js";

/**
 * Binding one non-body parameter onto the request under construction.
 *
 * The serialization table itself lives in `@anvil/air` (`param-style.ts`) so
 * the harness's wire oracle and the generated SDKs read the same rule. This
 * module only turns its answer into a mutation of the request parts, or into
 * the runtime's typed refusal — a value no style gives a meaning to is refused
 * here rather than sent as `[object Object]`.
 */
export interface RequestParts {
  query: URLSearchParams;
  headers: Record<string, string>;
}

function refusal(opId: string, p: Param, reason: string, traceId: string): AnvilError {
  return new AnvilError({
    code: "unsupported_operation",
    message:
      `Operation '${opId}' cannot put ${p.in} parameter '${p.name}' on the wire: ${reason}. ` +
      "Anvil refuses rather than sending a value the declared style cannot carry.",
    operation: opId,
    traceId,
    retryable: false,
    details: { param: p.name, in: p.in, style: p.style, explode: p.explode, reason },
  });
}

/**
 * Bind `value` for `p` into `parts`, returning the path (the one part that is
 * a string and so cannot be mutated in place). Body params are not this
 * module's business and must not reach it.
 */
export function bindParam(
  path: string,
  parts: RequestParts,
  p: Param,
  value: unknown,
  opId: string,
  traceId: string,
): string {
  switch (p.in) {
    case "path": {
      const bound = serializeSimpleParam(p, value, encodeURIComponent);
      if (!bound.ok) throw refusal(opId, p, bound.reason, traceId);
      return path.replace(`{${p.name}}`, bound.text);
    }
    case "header": {
      const bound = serializeSimpleParam(p, value);
      if (!bound.ok) throw refusal(opId, p, bound.reason, traceId);
      parts.headers[p.name] = bound.text;
      return path;
    }
    case "query": {
      const bound = serializeQueryParam(p, value);
      if (!bound.ok) throw refusal(opId, p, bound.reason, traceId);
      for (const [name, text] of bound.pairs) parts.query.append(name, text);
      return path;
    }
    case "cookie": {
      const bound = serializeQueryParam(p, value);
      if (!bound.ok) throw refusal(opId, p, bound.reason, traceId);
      const pairs = bound.pairs.map(([name, text]) => `${name}=${text}`).join("; ");
      parts.headers.cookie = `${parts.headers.cookie ? `${parts.headers.cookie}; ` : ""}${pairs}`;
      return path;
    }
    default:
      throw new Error(`bindParam received a ${p.in} parameter, which has no wire coordinate here`);
  }
}
