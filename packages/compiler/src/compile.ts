import {
  type AirDocument,
  type AuthRequirement,
  type JsonSchema,
  loadAirDocument,
  operationInputSchema,
  snakeCase,
} from "@anvil/air";
import { enrich, parseManifest } from "./manifest.js";
import { normalize } from "./normalize.js";
import { parseSpec } from "./parse.js";
import { validate } from "./validate.js";

export interface CompileInput {
  /** OpenAPI 3.x / Swagger 2.0 document text. */
  spec: string;
  /** Optional supplemental Anvil manifest text. */
  manifest?: string;
  /** Override the derived service id. */
  serviceId?: string;
  /** Provenance URI recorded in AIR. */
  sourceUri?: string;
}

/**
 * The compiler loop (spec §5): parse → normalize → enrich → validate → AIR.
 * This is the single canonical model every artifact is generated from.
 */
export async function compile(input: CompileInput): Promise<AirDocument> {
  const parsed = await parseSpec(input.spec);
  const doc = parsed.document;
  const manifest = input.manifest ? parseManifest(input.manifest) : { operations: {} };

  const title = (doc.info?.title as string | undefined) ?? "service";
  const serviceId = input.serviceId ?? manifest.service?.name ?? snakeCase(title) ?? "service";

  let operations = normalize(serviceId, parsed);
  operations = enrich(operations, manifest);

  // Attach the assembled input JSON Schema to each operation.
  for (const op of operations) {
    op.input.schema = operationInputSchema(op);
  }

  const { operations: validated, diagnostics } = validate(operations);

  const serviceAuth: AuthRequirement = validated.find((o) => o.auth.type !== "none")?.auth ?? {
    type: "none",
    scopes: [],
  };

  const air = {
    anvilVersion: "0.1.0",
    service: {
      id: serviceId,
      version: manifest.service?.environment
        ? `${(doc.info?.version as string) ?? "0.0.0"}-${manifest.service.environment}`
        : ((doc.info?.version as string) ?? "0.0.0"),
      displayName: manifest.service?.display_name ?? title,
      owner: manifest.service?.owner,
      environment: manifest.service?.environment,
      source: { kind: parsed.kind, uri: input.sourceUri },
      auth: serviceAuth,
      servers: (doc.servers ?? []).map((s) => ({ url: s.url, description: s.description })),
    },
    operations: validated,
    schemas: (doc.components?.schemas as Record<string, JsonSchema> | undefined) ?? {},
    diagnostics,
  };

  return loadAirDocument(air);
}

/** Approve operations by id (spec §17 approval workflow). */
export function approveOperations(air: AirDocument, ids: string[]): AirDocument {
  const set = new Set(ids);
  for (const op of air.operations) {
    if (set.has(op.id) && op.state !== "blocked") op.state = "approved";
  }
  return air;
}
