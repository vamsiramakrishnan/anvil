import { type AirDocument, effectClassOf, type Operation } from "@anvil/air";
import { type SdkOperation, sdkPlan } from "../sdk/plan.js";

/**
 * The composite catalog (ADR-0031): one language-neutral table of every
 * composed connector's callable operations, read by the Python and
 * TypeScript composite runtimes and by anything that plans across
 * connectors without importing an SDK (Worldloom, Branchyard).
 *
 * It carries nothing a connector's own SDK does not already decide: the
 * method each operation is bound to, its inputs (caller key and wire name),
 * its effect class and confirmation gate, and the undo AIR declares for it
 * (ADR-0030), with the argument mapping the composite resolves when asked to
 * compensate. The composite never invents an operation or a safety rule.
 */

export const COMPOSE_CATALOG_SCHEMA = "anvil.compose-catalog/v1";
export const COMPOSE_FLOW_SCHEMA = "anvil.compose-flow/v1";
export const COMPOSE_PLAN_SCHEMA = "anvil.compose-plan/v1";
export const COMPOSE_RUN_SCHEMA = "anvil.compose-run/v1";

/** The directory a harness home keeps the composite in, beside the connectors. */
export const COMPOSE_DIR = "_compose";

export interface ComposeInput {
  /** Caller key (the SDK keyword / object key). */
  key: string;
  /** The on-wire name; a flow may name an input by either. */
  wire: string;
  required: boolean;
}

export type ComposeArgumentSource = string | { const: unknown };

export interface ComposeUndo {
  kind: "inverse" | "compensate";
  operation: string;
  /** Follow-up input -> `request.<path>` / `response.<path>` / `{const}`; a trailing `?` is optional. */
  arguments: Record<string, ComposeArgumentSource>;
}

export interface ComposeOperation {
  id: string;
  title: string;
  /** Python method (snake) and TypeScript method (camel) on the connector client. */
  method: { python: string; typescript: string };
  /** Caller-facing names of the safety controls, as the connector SDK spells them. */
  safety: { confirm: string; idempotencyKey: string; dryRun: string };
  effect: "read" | "mutation";
  effectClass: "read" | "reversible" | "compensable" | "irreversible";
  confirm: boolean;
  idempotencyKeyRequired: boolean;
  inputs: ComposeInput[];
  undo?: ComposeUndo;
}

export interface ComposeConnector {
  id: string;
  title: string;
  service: { id: string; version: string };
  /** Where the connector's SDKs are, relative to the composite directory. */
  python: { path: string; package: string; client: string };
  typescript: { import: string; client: string };
  operations: ComposeOperation[];
}

export interface ComposeCatalog {
  schema: typeof COMPOSE_CATALOG_SCHEMA;
  connectors: ComposeConnector[];
}

/** One connector to compose: its AIR, the id the gateway serves it under, and where its SDKs live. */
export interface ComposeSource {
  connector: string;
  air: AirDocument;
  /** Relative to the composite directory: the directory holding the Python package. */
  pythonPath: string;
  /** Relative to the composite's `typescript/src`: the connector SDK's `index.js` module specifier. */
  typescriptImport: string;
}

function inputsOf(op: SdkOperation): ComposeInput[] {
  const inputs: ComposeInput[] = op.params.map((param) => ({
    key: param.key,
    wire: param.wireName,
    required: param.required,
  }));
  if (op.body?.projection === "fields") {
    for (const field of op.body.fields) {
      inputs.push({ key: field.key, wire: field.wireName, required: field.required });
    }
  } else if (op.body) {
    inputs.push({ key: "body", wire: "body", required: op.body.required });
  }
  return inputs;
}

function undoOf(op: Operation): ComposeUndo | undefined {
  const effectClass = effectClassOf(op);
  const declared =
    effectClass === "reversible" && op.effect.inverse
      ? { kind: "inverse" as const, call: op.effect.inverse }
      : effectClass === "compensable" && op.effect.compensate
        ? { kind: "compensate" as const, call: op.effect.compensate }
        : undefined;
  if (!declared) return undefined;
  return {
    kind: declared.kind,
    operation: declared.call.operation,
    arguments: { ...(declared.call.arguments as Record<string, ComposeArgumentSource>) },
  };
}

/** The catalog for a set of connectors. Refuses duplicate connector ids. */
export function composeCatalog(sources: readonly ComposeSource[]): ComposeCatalog {
  const seen = new Set<string>();
  const connectors: ComposeConnector[] = [];
  for (const source of sources) {
    if (seen.has(source.connector)) {
      throw new Error(`connector '${source.connector}' is composed twice`);
    }
    if (source.connector === COMPOSE_DIR) {
      throw new Error(`connector id '${COMPOSE_DIR}' is reserved for the composite itself`);
    }
    seen.add(source.connector);
    const plan = sdkPlan(source.air, { gatewayConnector: source.connector });
    const byId = new Map(source.air.operations.map((op) => [op.id, op]));
    const operations = plan.operations.map((sdkOp): ComposeOperation => {
      const op = byId.get(sdkOp.id) as Operation;
      const undo = undoOf(op);
      return {
        id: sdkOp.id,
        title: sdkOp.displayName,
        method: { python: sdkOp.names.snake, typescript: sdkOp.names.camel },
        safety: { ...sdkOp.safetyKeys },
        effect: sdkOp.effect,
        effectClass: effectClassOf(op),
        confirm: sdkOp.confirmation.required,
        idempotencyKeyRequired: sdkOp.idempotency.callerKeyRequired,
        inputs: inputsOf(sdkOp),
        ...(undo ? { undo } : {}),
      };
    });
    connectors.push({
      id: source.connector,
      title: plan.service.displayName || plan.service.id,
      service: { id: plan.service.id, version: plan.service.version },
      python: {
        path: source.pythonPath,
        package: `anvil_${plan.service.names.snake}`,
        client: `${plan.service.names.pascal}Client`,
      },
      typescript: {
        import: source.typescriptImport,
        client: `${plan.service.names.pascal}Client`,
      },
      operations,
    });
  }
  return { schema: COMPOSE_CATALOG_SCHEMA, connectors };
}
