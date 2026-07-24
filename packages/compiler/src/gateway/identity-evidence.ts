import { AuthCredentialCarrier, AuthPrincipal, type AuthType } from "@anvil/air";
import { z } from "zod";
import {
  type EvidenceCoordinate,
  type GatewayDiagnostic,
  GatewayIdentityEvidence,
  type GatewayIdentityEvidence as GatewayIdentityEvidenceValue,
} from "./model.js";
import { asRecord } from "./parse-safe.js";

/**
 * The deliberately small identity block accepted by normalized gateway inputs.
 *
 * It contains only facts a gateway export can state exactly. Token acquisition
 * coordinates are intentionally absent: a discovery URL or token endpoint is
 * never evidence of the issuer that signed the credential accepted by the API.
 */
export const ExplicitGatewayIdentityConfiguration = z.object({
  issuer: z.string().url().optional(),
  audience: z.string().min(1).optional(),
  carrier: AuthCredentialCarrier.optional(),
  principal: AuthPrincipal.optional(),
  scopes: z.array(z.string().min(1)).optional(),
});
export type ExplicitGatewayIdentityConfiguration = z.infer<
  typeof ExplicitGatewayIdentityConfiguration
>;

export interface IdentityEvidenceProjection {
  evidence: GatewayIdentityEvidenceValue[];
  diagnostics: GatewayDiagnostic[];
}

type ExplicitIdentityDimension = keyof ExplicitGatewayIdentityConfiguration;

const FIELD_SCHEMAS = {
  issuer: z.string().url(),
  audience: z.string().min(1),
  carrier: AuthCredentialCarrier,
  principal: AuthPrincipal,
  scopes: z.array(z.string().min(1)),
} satisfies Record<ExplicitIdentityDimension, z.ZodType>;

function pointerFor(base: string | undefined, field: string): string {
  const encoded = field.replaceAll("~", "~0").replaceAll("/", "~1");
  return `${base ?? ""}/${encoded}`;
}

function operationTargets(operationRefs: readonly string[]): Array<string | undefined> {
  const refs = [...new Set(operationRefs.filter((ref) => ref.trim().length > 0))].sort();
  return refs.length > 0 ? refs : [undefined];
}

/**
 * Project an explicit `identity` object (or an exact vendor config object with
 * the same field names) into one field-level evidence record per operation.
 *
 * Field-level records retain the coordinate that proves each fact. Malformed
 * declared identity is an error instead of being silently treated as absence.
 */
export function projectExplicitIdentityConfiguration(input: {
  configuration: unknown;
  coordinate: EvidenceCoordinate;
  operationRefs: readonly string[];
  /** Only inspect these exact keys when the vendor object contains unrelated config. */
  fields?: readonly ExplicitIdentityDimension[];
  /** Override a field coordinate when several native keys jointly prove one fact. */
  fieldCoordinates?: Partial<Record<ExplicitIdentityDimension, EvidenceCoordinate>>;
}): IdentityEvidenceProjection {
  if (input.configuration === undefined || input.configuration === null) {
    return { evidence: [], diagnostics: [] };
  }
  if (typeof input.configuration !== "object" || Array.isArray(input.configuration)) {
    return {
      evidence: [],
      diagnostics: [
        {
          level: "error",
          code: "gateway/invalid_identity_evidence",
          message:
            "Declared gateway identity configuration must be an object; it was not used as identity evidence.",
          coordinate: input.coordinate,
        },
      ],
    };
  }

  const configuration = asRecord(input.configuration);
  const fields = input.fields ?? (Object.keys(FIELD_SCHEMAS) as ExplicitIdentityDimension[]);
  const evidence: GatewayIdentityEvidenceValue[] = [];
  const diagnostics: GatewayDiagnostic[] = [];

  for (const field of fields) {
    if (!Object.hasOwn(configuration, field)) continue;
    const coordinate: EvidenceCoordinate = input.fieldCoordinates?.[field] ?? {
      origin: input.coordinate.origin,
      pointer: pointerFor(input.coordinate.pointer, field),
      ...(input.coordinate.span ? { span: input.coordinate.span } : {}),
    };
    const parsed = FIELD_SCHEMAS[field].safeParse(configuration[field]);
    if (!parsed.success) {
      diagnostics.push({
        level: "error",
        code: "gateway/invalid_identity_evidence",
        message: `Gateway identity field '${field}' has an unsupported value and was not used as evidence.`,
        coordinate,
      });
      continue;
    }
    for (const operationRef of operationTargets(input.operationRefs)) {
      evidence.push(
        GatewayIdentityEvidence.parse({
          coordinate,
          basis: "explicit_configuration",
          ...(operationRef ? { operationRef } : {}),
          [field]: parsed.data,
        }),
      );
    }
  }
  return { evidence, diagnostics };
}

/**
 * Preserve a configured authentication family separately from exact identity
 * fields. A plugin/policy name may prove a normalized auth type, but it cannot
 * prove issuer, audience, carrier, principal, or scopes.
 */
export function projectConfiguredAuthType(input: {
  type: AuthType;
  coordinate: EvidenceCoordinate;
  operationRefs: readonly string[];
}): GatewayIdentityEvidenceValue[] {
  return operationTargets(input.operationRefs).map((operationRef) =>
    GatewayIdentityEvidence.parse({
      coordinate: input.coordinate,
      basis: "configured_plugin_type",
      ...(operationRef ? { operationRef } : {}),
      type: input.type,
    }),
  );
}

/** Merge projector results without losing field-level validation diagnostics. */
export function mergeIdentityEvidence(
  ...parts: readonly IdentityEvidenceProjection[]
): IdentityEvidenceProjection {
  return {
    evidence: parts.flatMap((part) => part.evidence),
    diagnostics: parts.flatMap((part) => part.diagnostics),
  };
}
