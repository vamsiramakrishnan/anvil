import { hashCanonical } from "@anvil/air";

export interface RegressionIdentity {
  bundle: string;
  runtime: string;
  policy: string;
  upstream: string;
}
export interface CapturedRegression {
  version: 1;
  identity: RegressionIdentity;
  operation: string;
  category: "contract" | "provider" | "authorization" | "selection";
  input: Record<string, unknown>;
  expectedError: string;
  digest: string;
}
const forbidden = /authorization|password|secret|token|cookie|credential|private.?key/i;

/** Explicit field projection. No payload is retained unless a trusted operator supplies an allowlist. */
export function captureRegression(options: {
  identity: RegressionIdentity;
  operation: string;
  input: Record<string, unknown>;
  allowedFields?: readonly string[];
  expectedError: string;
  category: CapturedRegression["category"];
}): CapturedRegression {
  if (
    !/^[a-zA-Z0-9_.:/-]{1,256}$/.test(options.operation) ||
    !/^[a-z][a-z0-9_./-]{0,127}$/.test(options.expectedError) ||
    !["contract", "provider", "authorization", "selection"].includes(options.category) ||
    [
      options.identity.bundle,
      options.identity.runtime,
      options.identity.policy,
      options.identity.upstream,
    ].some((v) => typeof v !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(v))
  )
    throw new Error("Regression identity is incomplete");
  const input: Record<string, unknown> = {};
  for (const field of options.allowedFields ?? []) {
    if (!/^[a-z][a-z0-9_]*$/.test(field) || forbidden.test(field))
      throw new Error("Forbidden capture field");
    const value = options.input[field];
    // Nested payloads need separate reviewed schemas; opaque objects must never pass a shallow allowlist.
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      typeof value !== "number"
    )
      throw new Error("Capture fields must be scalar");
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("Invalid captured number");
    if (
      typeof value === "string" &&
      (value.length > 4096 || /Bearer\s|-----BEGIN .*PRIVATE KEY/.test(value))
    )
      throw new Error("Credential-like or oversized captured value");
    input[field] = value;
  }
  const value = structuredClone({
    version: 1 as const,
    identity: options.identity,
    operation: options.operation,
    category: options.category,
    expectedError: options.expectedError,
    input,
  });
  return { ...value, digest: hashCanonical(value) };
}

/** Replay is provided by an operator-owned isolated fixture, never by a production transport. */
export async function minimizeRegression(
  raw: CapturedRegression,
  fixture: {
    isolated: true;
    identity: RegressionIdentity;
    /** Each call must reset backend state. This oracle checks the same independent failure. */
    reproduces(input: Record<string, unknown>): Promise<boolean>;
  },
  budget = 32,
) {
  const { digest, ...content } = structuredClone(raw);
  if (
    hashCanonical(content) !== digest ||
    fixture.isolated !== true ||
    hashCanonical(fixture.identity) !== hashCanonical(raw.identity) ||
    !Number.isSafeInteger(budget) ||
    budget < 1 ||
    budget > 100
  )
    throw new Error("Unbound regression fixture or budget");
  let calls = 1;
  let input = structuredClone(raw.input);
  if (!(await fixture.reproduces(structuredClone(input))))
    throw new Error("Failure does not reproduce");
  for (const key of Object.keys(input).sort()) {
    if (calls >= budget) break;
    const candidate = { ...input };
    delete candidate[key];
    calls++;
    if (await fixture.reproduces(structuredClone(candidate))) input = candidate;
  }
  const result = { ...content, input };
  return {
    regression: { ...result, digest: hashCanonical(result) },
    calls,
    proposalOnly: true as const,
  };
}
