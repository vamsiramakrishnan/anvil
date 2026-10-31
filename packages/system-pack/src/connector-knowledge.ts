import { AirDocument, BusinessDefinition, hashCanonical } from "@anvil/air";

export interface ConnectorKnowledge {
  version: 1;
  id: string;
  revision: string;
  definition: unknown;
  sources: Record<string, unknown>;
  fixtures: Record<string, unknown>;
  evidence: Record<string, { sourceHash: string; reportDigest: string; checks: string[] }>;
  digest: string;
}

/** Serializable knowledge; installation always returns proposals, never transferred approvals. */
export function createConnectorKnowledge(
  input: Omit<ConnectorKnowledge, "version" | "digest">,
): ConnectorKnowledge {
  if (!/^[a-z][a-z0-9-]+$/.test(input.id) || !input.revision)
    throw new Error("Invalid connector identity");
  const definition = BusinessDefinition.parse(input.definition);
  const sources = Object.fromEntries(
    Object.entries(input.sources).map(([name, raw]) => [name, AirDocument.parse(raw)]),
  );
  for (const [name, source] of Object.entries(sources)) {
    const evidence = input.evidence[name];
    if (
      !evidence ||
      evidence.sourceHash !== hashCanonical(source) ||
      !/^[a-f0-9]{64}$/.test(evidence.reportDigest) ||
      !evidence.checks.length ||
      evidence.checks.some((id) => !id)
    )
      throw new Error(`Missing hash-bound qualification for ${name}`);
  }
  if (!Object.keys(input.fixtures).length)
    throw new Error("Connector knowledge needs qualification fixtures");
  for (const action of definition.actions)
    for (const step of action.steps)
      if (!sources[step.source]?.operations.some((op) => op.id === step.operationId))
        throw new Error("Connector definition references an absent operation");
  const value = structuredClone({
    id: input.id,
    revision: input.revision,
    fixtures: input.fixtures,
    evidence: input.evidence,
    version: 1 as const,
    definition,
    sources,
  });
  return { ...value, digest: hashCanonical(value) };
}

export function prepareConnectorInstall(
  raw: ConnectorKnowledge,
  expectedDigest: string,
  installedSources: Record<string, unknown>,
) {
  const { digest, version, ...input } = raw;
  const verified = createConnectorKnowledge(input);
  if (version !== 1 || digest !== verified.digest || digest !== expectedDigest)
    throw new Error("Connector package integrity mismatch");
  const differences = Object.keys(raw.sources).filter(
    (name) =>
      !installedSources[name] ||
      hashCanonical(AirDocument.parse(installedSources[name])) !== hashCanonical(raw.sources[name]),
  );
  if (differences.length)
    throw new Error(`Connector needs migration review: ${differences.join(", ")}`);
  const definition = BusinessDefinition.parse(raw.definition);
  for (const action of definition.actions) action.state = "proposed";
  const sources = Object.fromEntries(
    Object.entries(raw.sources).map(([name, source]) => {
      const air = AirDocument.parse(source);
      for (const op of air.operations) if (op.state === "approved") op.state = "review_required";
      for (const workflow of air.workflows)
        if (workflow.state === "approved") workflow.state = "review_required";
      for (const cap of air.capabilities) {
        cap.state = "review_required";
        cap.lifecycle = "proposed";
      }
      return [name, air];
    }),
  );
  return { definition, sources, packageDigest: digest, reviewRequired: true as const };
}

export function connectorMigration(before: ConnectorKnowledge, after: ConnectorKnowledge) {
  for (const pack of [before, after]) {
    const { version, digest, ...input } = pack;
    if (version !== 1 || createConnectorKnowledge(input).digest !== digest)
      throw new Error("Invalid connector package");
  }
  if (before.id !== after.id) throw new Error("Connector identities differ");
  const names = [
    ...new Set([...Object.keys(before.sources), ...Object.keys(after.sources)]),
  ].sort();
  return {
    from: before.digest,
    to: after.digest,
    reviewRequired: before.digest !== after.digest,
    changedSources: names.filter(
      (n) => hashCanonical(before.sources[n] ?? null) !== hashCanonical(after.sources[n] ?? null),
    ),
    definitionChanged: hashCanonical(before.definition) !== hashCanonical(after.definition),
  };
}
