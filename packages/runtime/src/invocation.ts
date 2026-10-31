import {
  effectiveAuthCarrier,
  hashCanonical,
  type Operation,
  operationInputSchema,
  operationSafetyInputKeys,
  resolveIdempotencyCarrier,
  validateBusinessValue,
} from "@anvil/air";
import { AnvilError } from "./errors.js";

/** Credential-free semantic request. Wire encoding happens only after policy and validation. */
export interface InvocationPlan {
  readonly version: 1;
  readonly operation: string;
  readonly contractDigest: string;
  readonly targetDigest: string;
  readonly principal: string;
  readonly traceId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}
export interface InvocationEdit {
  arguments: Record<string, unknown>;
  headers?: Record<string, string>;
}
export type InvocationTransform = (
  plan: InvocationPlan,
) => InvocationEdit | Promise<InvocationEdit>;

/** Transform modules see the preceding module's arguments; header edits accumulate in load order. */
export function composeInvocationTransforms(
  transforms: readonly InvocationTransform[],
): InvocationTransform {
  return async (initial) => {
    let arguments_ = structuredClone(initial.arguments);
    const headers: Record<string, string> = {};
    for (const transform of transforms) {
      const edit = structuredClone(await transform(freeze({ ...initial, arguments: arguments_ })));
      if (
        !edit ||
        !edit.arguments ||
        Array.isArray(edit.arguments) ||
        typeof edit.arguments !== "object" ||
        Object.keys(edit).some((key) => key !== "arguments" && key !== "headers")
      )
        throw new Error("Invalid invocation edit");
      arguments_ = edit.arguments;
      if (
        edit.headers !== undefined &&
        (!edit.headers || Array.isArray(edit.headers) || typeof edit.headers !== "object")
      )
        throw new Error("Invalid invocation headers");
      for (const [name, value] of Object.entries(edit.headers ?? {}))
        headers[name.toLowerCase()] = value;
    }
    return { arguments: arguments_, ...(Object.keys(headers).length ? { headers } : {}) };
  };
}

export function invocationHeaderIdentity(edit: InvocationEdit): Record<string, string> {
  if (!Object.keys(edit.headers ?? {}).length) return {};
  return {
    policyHeaders: hashCanonical(
      Object.fromEntries(Object.entries(edit.headers!).map(([k, v]) => [k.toLowerCase(), v])),
    ),
  };
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

export async function prepareInvocation(options: {
  operation: Operation;
  input: Record<string, unknown>;
  target: unknown;
  principal: string;
  traceId: string;
  transform?: InvocationTransform;
}): Promise<InvocationEdit> {
  if (!options.transform) return { arguments: options.input };
  const original = structuredClone(options.input);
  const plan = freeze<InvocationPlan>({
    version: 1,
    operation: options.operation.id,
    contractDigest: hashCanonical(options.operation),
    targetDigest: hashCanonical(options.target),
    principal: options.principal,
    traceId: options.traceId,
    arguments: original,
  });
  const edit = structuredClone(await options.transform(plan));
  const deny = () => {
    throw new AnvilError({
      code: "policy_denied",
      operation: options.operation.id,
      traceId: options.traceId,
      message: "Invocation policy may transform business arguments and custom headers only.",
    });
  };
  if (
    !edit ||
    !edit.arguments ||
    typeof edit.arguments !== "object" ||
    Array.isArray(edit.arguments) ||
    Object.keys(edit).some((k) => k !== "arguments" && k !== "headers")
  )
    return deny();
  const safety = operationSafetyInputKeys(options.operation);
  for (const key of [safety.confirm, safety.idempotencyKey])
    if (hashCanonical(edit.arguments[key] ?? null) !== hashCanonical(original[key] ?? null))
      return deny();
  const schema = operationInputSchema(options.operation);
  // Explicit confirm/key arguments are supplied separately by some serving surfaces.
  // Required-field checks still run in execute after this transformation.
  if (!validateBusinessValue({ ...schema, required: [] }, edit.arguments)) return deny();
  if (
    edit.headers !== undefined &&
    (!edit.headers || typeof edit.headers !== "object" || Array.isArray(edit.headers))
  )
    return deny();
  const auth = effectiveAuthCarrier(options.operation.auth);
  const idempotency = resolveIdempotencyCarrier(options.operation);
  const names = new Set<string>();
  // Auth material and protocol/session framing are owned by the transport and credential resolver.
  for (const [key, value] of Object.entries(edit.headers ?? {})) {
    if (
      names.has(key.toLowerCase()) ||
      (auth?.in === "header" && auth.name.toLowerCase() === key.toLowerCase()) ||
      (idempotency.ok &&
        idempotency.binding?.mechanism === "header" &&
        idempotency.binding.key.toLowerCase() === key.toLowerCase()) ||
      typeof value !== "string" ||
      /[\r\n]/.test(value) ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
      /^(authorization|proxy-authorization|cookie|host|content-length|content-type|accept|connection|transfer-encoding|mcp-.*|last-event-id)$/i.test(
        key,
      )
    )
      return deny();
    names.add(key.toLowerCase());
  }
  return edit;
}

/** Resolver-supplied custom credentials remain authoritative even when AIR has no named carrier. */
export function assertInvocationCredentialHeaders(
  edit: InvocationEdit,
  headers: Record<string, string> | undefined,
  operation: string,
  traceId: string,
): void {
  const credentials = new Set(Object.keys(headers ?? {}).map((key) => key.toLowerCase()));
  if (Object.keys(edit.headers ?? {}).some((key) => credentials.has(key.toLowerCase())))
    throw new AnvilError({
      code: "policy_denied",
      operation,
      traceId,
      message: "Invocation policy header conflicts with resolved credentials.",
    });
}
