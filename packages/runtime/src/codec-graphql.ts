import type { GraphqlWireBinding, Operation } from "@anvil/air";
import type { FaultAwareCodec, WireFault, WireParts } from "./codec.js";
import type { HttpRequest, HttpResponse } from "./transport.js";

/**
 * GraphQL over HTTP.
 *
 * Much smaller than the SOAP codec, and deliberately so: the query document was
 * compiled from the SDL and stored on the operation, so this posts a string it
 * was handed alongside the caller's validated input as `variables`. Nothing here
 * builds a query, which means no agent-supplied value is ever interpolated into
 * one — the same rule the SQL query policy enforces one layer over, for the same
 * reason.
 */

const GRAPHQL_CONTENT_TYPE = "application/json";

function bindingOf(op: Operation): GraphqlWireBinding {
  const binding = op.sourceRef.binding;
  if (binding?.protocol !== "graphql") {
    // Unreachable through the executor — `wireExecutability` refuses an
    // operation with no GraphQL binding before a request is built.
    throw new Error(`operation '${op.id}' reached the GraphQL codec with no wire binding`);
  }
  return binding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const graphqlCodec: FaultAwareCodec = {
  protocol: "graphql",

  encode(op: Operation, parts: WireParts): HttpRequest {
    const binding = bindingOf(op);
    // A GraphQL service serves one endpoint. `/graphql/Query/product` is a
    // coordinate Anvil synthesized to hold operations apart in a path-keyed
    // model; the field name travels in the document, never in the URL.
    return {
      method: "POST",
      url: parts.baseUrl.replace(/\/$/, "") || "/",
      headers: {
        ...parts.headers,
        "content-type": GRAPHQL_CONTENT_TYPE,
        accept: "application/json",
      },
      body: JSON.stringify({
        query: binding.document,
        operationName: binding.operationName,
        variables: isRecord(parts.body) ? parts.body : {},
      }),
    };
  },

  decode(op: Operation, res: HttpResponse): unknown {
    if (!res.body) return null;
    const parsed: unknown = JSON.parse(res.body);
    if (!isRecord(parsed)) return parsed;
    const data = parsed.data;
    if (!isRecord(data)) return data ?? null;
    // Unwrap the root field the operation actually called, so the caller gets
    // the shape AIR's output contract describes rather than GraphQL's envelope.
    const binding = op.sourceRef.binding;
    const root = binding?.protocol === "graphql" ? binding.rootField : undefined;
    return root !== undefined && root in data ? data[root] : data;
  },

  /**
   * GraphQL reports failures inside a 200 with an `errors` array — the same
   * shape of problem as a SOAP Fault, and the same danger: reported as a result,
   * a failed mutation would be recorded in the idempotency ledger as completed.
   *
   * A partial response (`data` present *and* `errors` present) is still a
   * failure here. Anvil's output contract describes one shape, and handing an
   * agent a half-filled one alongside errors it cannot see is how a caller
   * acts on data that was never really returned.
   */
  faultIn(_op: Operation, res: HttpResponse): WireFault | undefined {
    if (!res.body) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      return undefined;
    }
    if (!isRecord(parsed)) return undefined;
    const errors = parsed.errors;
    if (!Array.isArray(errors) || errors.length === 0) return undefined;

    const first = errors[0];
    const message =
      isRecord(first) && typeof first.message === "string"
        ? first.message
        : "the service returned a GraphQL error";
    const extensions = isRecord(first) ? first.extensions : undefined;
    const code =
      isRecord(extensions) && typeof extensions.code === "string"
        ? extensions.code
        : "graphql_error";

    // GraphQL has no transport-versus-application distinction of its own, and
    // no convention that identifies a transient error. Treating one as
    // retryable would mean guessing, and guessing wrong on a mutation is the
    // failure mode the safety contract exists to prevent — so none of them are.
    return {
      code,
      message: errors.length > 1 ? `${message} (and ${errors.length - 1} more)` : message,
      retryable: false,
    };
  },
};
