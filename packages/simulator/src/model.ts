/**
 * The contract-faithful simulator model.
 *
 * A `SimulatorDefinition` is derived from a capability's AIR + surface signature,
 * so the simulator serves exactly the capability's operations with the same
 * public surface. The hard invariant (enforced by test): a simulator's
 * `SurfaceSignature` equals the generated MCP's — a downstream agent can swap the
 * simulator and production bindings without changing its business contract.
 *
 * Everything is deterministic and seeded: same seed + same call sequence → same
 * outputs, so a simulator run is reproducible.
 */
import { z } from "zod";

/** A domain entity the simulator stores and mutates. */
export const EntityDefinition = z.object({
  /** The resource noun, e.g. "refund". */
  name: z.string(),
  /** The id field used as the store key. */
  idField: z.string().default("id"),
  /** Field names seeded onto a fixture entity (values are seeded deterministically). */
  fields: z.array(z.string()).default([]),
});
export type EntityDefinition = z.infer<typeof EntityDefinition>;

/** A simple domain state machine (states + allowed transitions). */
export const StateMachineDefinition = z.object({
  entity: z.string(),
  stateField: z.string().default("status"),
  initial: z.string(),
  /** from-state → the states it may transition to. */
  transitions: z.record(z.string(), z.array(z.string())).default({}),
});
export type StateMachineDefinition = z.infer<typeof StateMachineDefinition>;

/** A set of seed fixtures for an entity (how many to pre-populate). */
export const FixtureSet = z.object({
  entity: z.string(),
  count: z.number().int().min(0).default(0),
});
export type FixtureSet = z.infer<typeof FixtureSet>;

/** A named, seeded fault profile a scenario can activate. */
export const FaultProfile = z.object({
  scenario: z.string(),
  kind: z.enum(["latency", "rate_limit", "transient", "conflict", "eventual_consistency"]),
  /** Probability 0..1 the fault fires on a matching call (seeded, deterministic). */
  rate: z.number().min(0).max(1).default(1),
});
export type FaultProfile = z.infer<typeof FaultProfile>;

/** A simulated caller identity with granted scopes and role. */
export const SimulatedPrincipal = z.object({
  id: z.string(),
  role: z.string().default("user"),
  scopes: z.array(z.string()).default([]),
});
export type SimulatedPrincipal = z.infer<typeof SimulatedPrincipal>;

/** The full definition a simulator runs. */
export const SimulatorDefinition = z.object({
  schemaVersion: z.literal(1),
  capabilityId: z.string(),
  /** The surface this simulator must match — identical to the generated MCP's. */
  surfaceSignatureDigest: z.string(),
  seed: z.number().int(),
  entities: z.array(EntityDefinition).default([]),
  machines: z.array(StateMachineDefinition).default([]),
  fixtures: z.array(FixtureSet).default([]),
  faults: z.array(FaultProfile).default([]),
  authProfiles: z.array(SimulatedPrincipal).default([]),
});
export type SimulatorDefinition = z.infer<typeof SimulatorDefinition>;
