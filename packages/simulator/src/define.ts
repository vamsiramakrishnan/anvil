/**
 * Derive a `SimulatorDefinition` from a capability's AIR. The simulator serves
 * exactly the approved operations the generated MCP serves, and stamps the same
 * surface-signature digest — so simulator↔production parity holds by construction.
 */
import { type AirDocument, snakeCase } from "@anvil/air";
import { surfaceSignatureFor } from "@anvil/compiler";
import type {
  EntityDefinition,
  FaultProfile,
  FixtureSet,
  SimulatedPrincipal,
  SimulatorDefinition,
  StateMachineDefinition,
} from "./model.js";

export interface DefineOptions {
  capabilityId?: string;
  seed?: number;
  fixturesPerEntity?: number;
}

/** The served operations: approved, and in the capability when one is named. */
function servedOperations(air: AirDocument, capabilityId?: string) {
  const memberIds = capabilityId
    ? new Set(air.capabilities.find((c) => c.id === capabilityId)?.operationIds ?? [])
    : undefined;
  return air.operations.filter(
    (op) => op.state === "approved" && (!memberIds || memberIds.has(op.id)),
  );
}

/** Default fault scenarios every simulator supports. */
const DEFAULT_FAULTS: FaultProfile[] = [
  { scenario: "throttle", kind: "rate_limit", rate: 1 },
  { scenario: "outage", kind: "transient", rate: 1 },
  { scenario: "conflict", kind: "conflict", rate: 1 },
  { scenario: "slow", kind: "latency", rate: 1 },
];

export function simulatorDefinitionFor(
  air: AirDocument,
  options: DefineOptions = {},
): SimulatorDefinition {
  const capabilityId = options.capabilityId ?? air.service.id;
  const ops = servedOperations(air, options.capabilityId);

  const resources = [
    ...new Set(
      ops.map(
        (op) => op.effect.resource ?? snakeCase(op.canonicalName).split("_").pop() ?? "resource",
      ),
    ),
  ].sort();
  const entities: EntityDefinition[] = resources.map((name) => ({
    name,
    idField: "id",
    fields: ["id", "status"],
  }));

  const machines: StateMachineDefinition[] = entities.map((e) => ({
    entity: e.name,
    stateField: "status",
    initial: "active",
    transitions: { active: ["updated", "cancelled"], updated: ["cancelled"] },
  }));

  const fixtures: FixtureSet[] = entities.map((e) => ({
    entity: e.name,
    count: options.fixturesPerEntity ?? 3,
  }));

  const scopes = [...new Set(ops.flatMap((op) => op.auth.scopes))].sort();
  const authProfiles: SimulatedPrincipal[] = [
    { id: "admin", role: "admin", scopes },
    { id: "limited", role: "user", scopes: [] },
  ];

  const surfaceSignatureDigest = surfaceSignatureFor(air, options.capabilityId).digest;

  return {
    schemaVersion: 1,
    capabilityId,
    surfaceSignatureDigest,
    seed: options.seed ?? 1,
    entities,
    machines,
    fixtures,
    faults: DEFAULT_FAULTS,
    authProfiles,
  };
}
