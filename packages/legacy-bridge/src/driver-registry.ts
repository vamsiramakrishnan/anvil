import { hashCanonical, validateBusinessValue } from "@anvil/air";

export interface DriverBinding {
  id: string;
  driver: string;
  version: string;
  target: string;
  parameters: string[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  scopes: string[];
  approved: boolean;
  timeoutMs: number;
}
export interface QualifiedDriver {
  name: string;
  version: string;
  invoke(
    binding: Readonly<DriverBinding>,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
}
export interface DriverQualification {
  bindingDigest: string;
  reportDigest: string;
  passed: boolean;
}

/** Operator-owned registry. A discovered binding is never sufficient to execute. */
export class QualifiedDriverRegistry {
  private readonly entries = new Map<string, { binding: DriverBinding; driver: QualifiedDriver }>();
  register(binding: DriverBinding, driver: QualifiedDriver, proof: DriverQualification): void {
    if (
      !binding.approved ||
      !binding.id ||
      this.entries.has(binding.id) ||
      driver.name !== binding.driver ||
      driver.version !== binding.version ||
      !proof.passed ||
      proof.bindingDigest !== hashCanonical(binding) ||
      !/^[a-f0-9]{64}$/.test(proof.reportDigest) ||
      !Number.isSafeInteger(binding.timeoutMs) ||
      binding.timeoutMs < 100 ||
      binding.timeoutMs > 30_000 ||
      new Set(binding.parameters).size !== binding.parameters.length
    )
      throw new Error("Driver binding is unqualified, duplicate or mismatched");
    if (binding.inputSchema.type !== "object")
      throw new Error("Driver input must be an object schema");
    validateBusinessValue(binding.inputSchema, undefined);
    validateBusinessValue(binding.outputSchema, undefined);
    this.entries.set(binding.id, { binding: structuredClone(binding), driver });
  }
  async execute(
    id: string,
    input: Record<string, unknown>,
    context: {
      signal?: AbortSignal;
      /** Must check current caller, tenant and source grants, not a model-provided claim. */
      authorize(binding: Readonly<DriverBinding>): Promise<boolean>;
    },
  ): Promise<{ outcome: "completed"; value: unknown } | { outcome: "unknown"; retryable: false }> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Driver is not qualified for this binding");
    const binding = structuredClone(entry.binding),
      args = structuredClone(input);
    if (
      Object.keys(args).length !== binding.parameters.length ||
      binding.parameters.some((p) => !Object.hasOwn(args, p)) ||
      !validateBusinessValue(binding.inputSchema, args)
    )
      throw new Error("Procedure parameters do not match the reviewed binding");
    if (!(await context.authorize(structuredClone(binding))))
      throw new Error("Driver authorization denied");
    const signal = AbortSignal.any([
      AbortSignal.timeout(binding.timeoutMs),
      ...(context.signal ? [context.signal] : []),
    ]);
    signal.throwIfAborted();
    let onAbort: () => void = () => {};
    try {
      const value = await Promise.race([
        entry.driver.invoke(binding, args, signal),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error("Driver deadline or cancellation"));
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
      if (Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024)
        throw new Error("Driver output limit");
      if (!validateBusinessValue(binding.outputSchema, value))
        throw new Error("Invalid driver output");
      return { outcome: "completed", value };
    } catch {
      // A timed-out write may still commit. The registry never retries or invents rollback.
      return { outcome: "unknown", retryable: false };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export interface ProcedureClient {
  /** Adapter must bind values with the database driver and honor cancellation; never concatenate values. */
  query(sql: string, parameters: unknown[], signal: AbortSignal): Promise<unknown>;
}
export function postgresProcedureDriver(client: ProcedureClient): QualifiedDriver {
  return {
    name: "postgres-procedure",
    version: "1",
    async invoke(binding, input, signal) {
      const names = binding.target.split(".");
      if (names.length !== 2 || names.some((n) => !/^[a-z_][a-z0-9_]*$/.test(n)))
        throw new Error("Invalid reviewed procedure target");
      const placeholders = binding.parameters.map((_p, i) => `$${i + 1}`).join(", ");
      return client.query(
        `CALL "${names[0]}"."${names[1]}"(${placeholders})`,
        binding.parameters.map((p) => input[p]),
        signal,
      );
    },
  };
}
