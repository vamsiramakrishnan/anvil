import { GATEWAY_SUPPORT_CONTRACTS } from "@anvil/compiler";

export function gatewaySupportMarkdownTable(): string {
  const tier = (value: (typeof GATEWAY_SUPPORT_CONTRACTS)[number]["releaseTier"]) =>
    value.replaceAll("_", " ");
  return [
    "| Vendor | Release tier | Directly understood input today |",
    "| --- | --- | --- |",
    ...GATEWAY_SUPPORT_CONTRACTS.map((contract) => {
      const input =
        contract.acceptedInputs.length > 0
          ? contract.acceptedInputs.map((candidate) => candidate.description).join(" ")
          : "No accepted input; research contract only.";
      return `| ${contract.displayName} | \`${tier(contract.releaseTier)}\` | ${input} |`;
    }),
  ].join("\n");
}

export function legacyEstatesRef(): string {
  return `# Inventory a legacy estate before building a bridge

When an application has no useful API description, start from deployed evidence,
not a guessed tool schema. Export the selected environment into one directory,
then run:

\`\`\`bash
anvil legacy inventory <offline-export> \\
  --environment <environment-id> \\
  --application <application-id> \\
  --out legacy.inventory.json
\`\`\`

The default \`auto\` lane runs only applicable offline collectors. Select
\`--collector java-ee\`, \`dotnet\`, or \`messaging\` when a collection is
intentionally limited to one vocabulary. Use \`--source-kind\` and \`--source-id\`
to preserve where the evidence came from; use \`--check\` when CI must stop on
unresolved conflicts.

A harness that already owns artifact acquisition may call the same pure pipeline
through \`collectLegacyInventory\` from \`@anvil/compiler/legacy\`. The SDK accepts
caller-supplied bytes; the caller owns safe acquisition. Use the CLI when Anvil
should enforce the bounded, no-symlink filesystem boundary.

## Accepted declarative evidence

- Java EE deployment descriptors plus grounded WebLogic, WebSphere, and JBoss
  binding fragments;
- WCF configuration and explicit IIS/Windows Service inventory JSON; DLL and EXE
  files are hashed but never loaded; and
- AsyncAPI, IBM MQ MQSC/CCDT, Artemis, RabbitMQ, and Kafka exports.

Supply regular files or an already hardened-expanded directory. The CLI refuses
symbolic links and never opens an EAR, WAR, RAR, ZIP, or other nested archive.
It never connects to an application server or broker, runs bytecode, loads an
assembly, consumes a message, or retains active secret values.

## Read the output literally

An inventory candidate proves a technical invocation boundary. It does not prove
a business operation, business effect, idempotency, authorization model, safe
retry policy, or permission to invoke it. Physical queue/JNDI/address bindings
are evidence-backed \`binding_target\` claims; competing targets remain an
explicit conflict even when one source normally ranks higher.

Cross-protocol records are not merged merely because two names look alike. A
Java logical destination, an MQ object, and an AsyncAPI channel stay separately
reviewable until a reviewed mapping proves the link. Preserve the inventory ID
with that review so a changed export invalidates the conclusion.

The safe progression is:

\`\`\`text
offline evidence → inventory → conflict review → accepted business semantics
→ AIR transport binding → business-shaped MCP → deployment-local bridge
\`\`\`

Never replace that last surface with generic \`consume_queue\`, \`put_message\`,
\`invoke_any_ejb\`, or \`call_any_mbean\` tools. Broker acknowledgement means
accepted by the transport; it does not mean the business work completed.
`;
}
