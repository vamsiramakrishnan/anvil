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

When an application has no useful API description, start from offline evidence,
not a guessed tool schema. Scope one collection to one application, environment,
and evidence authority, then run:

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

If acquisition spans several evidence authorities, address a strict collection
manifest first:

\`\`\`bash
anvil legacy plan collection-plan.json --out collection-plan.addressed.json
\`\`\`

The plan requires revision-pinned repository evidence and cannot express
unsafe acquisition modes. It validates and content-addresses the acquisition
contract; it does not fetch artifacts, execute collection, or merge inventories.

One inventory invocation assigns the same source kind and source-system ID to
every member. Keep Git, artifact-repository, production-server, and broker
exports in separate runs when their provenance differs. The current CLI does
not merge several source authorities into one snapshot; never invent a shared
label to force a merge. Refinement is bound to one inventory; evidence outside
it must use an appropriate immutable external evidence reference.

A harness that already owns artifact acquisition may call the same pure pipeline
through \`collectLegacyInventory\` from \`@anvil/compiler/legacy\`. Product SDK
surfaces also include \`createLegacyCollectionPlan\`,
\`projectLegacyEvidenceGraph\`, \`assessAndPlanLegacyCoverage\`,
\`explainLegacyCandidate\`, and \`diffLegacyInventories\`. The SDK accepts
caller-supplied bytes and records; the caller owns safe acquisition. Use the CLI
when Anvil should enforce the bounded, no-symlink filesystem boundary.

## Accepted declarative evidence

- Java EE descriptors, grounded WebLogic/WebSphere/JBoss binding fragments, and
  inert Jakarta/Javax EJB source annotations; class files are digest-only;
- explicit WCF, MSMQ, \`.svc\`, \`serviceActivations\`, IIS, and Windows Service
  configuration; DLL and EXE files are digest-only; and
- AsyncAPI, IBM MQ MQSC/CCDT, Artemis, allowlisted RabbitMQ topology, Kafka
  Admin and Schema Registry shapes, and Strimzi \`KafkaTopic\` and
  \`KafkaConnector\` resources.

Supply regular files or an already hardened-expanded directory. The CLI refuses
symbolic links and never opens an EAR, WAR, RAR, ZIP, or other nested archive.
It never connects to an application server or broker, runs bytecode, loads an
assembly, or consumes a message. RabbitMQ users, permissions, passwords, and
credential hashes never enter observations, evidence, or diagnostics. A
credential-bearing artifact is refused when a safe topology-only projection
cannot be proven.

If a collector retains hosting, schema, or other useful metadata but proves no
callable technical boundary, it emits
\`legacy/<collector>/no_invocation_candidate\` instead of presenting an empty
inventory as success.

AsyncAPI logical channel keys and operation identity remain separate from the
physical address; declared reply, correlation, and discriminator evidence is
retained. Schema Registry observations retain subject, version, type,
compatibility, references, and a schema digest instead of the schema body.

The repository corpus manifest pins 16 licensed public application-server,
.NET, and messaging specimens by commit and SHA-256. Its oracles cover expected
behavior, deterministic reruns, and sensitive-output exclusion; third-party
bytes are fetched for the check and are never vendored.

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

Use the product views to decide what is known and what evidence is still
required:

\`\`\`bash
anvil legacy graph legacy.inventory.json --out legacy.graph.json
anvil legacy gaps legacy.inventory.json \\
  --plan collection-plan.addressed.json --check --out legacy.gaps.json
anvil legacy explain legacy.inventory.json <lc_candidate_id> --out explanation.json
anvil legacy diff previous.inventory.json legacy.inventory.json --out inventory.diff.json
\`\`\`

\`graph\` projects typed evidence links. \`gaps\` measures semantic completeness
independently of collector yield. \`explain\` traces one candidate to its claims
and artifacts. \`diff\` separates logical-lineage changes from deployment
occurrence changes.

The safe progression is:

\`\`\`text
offline evidence → inventory → conflict review → accepted business semantics
→ reviewed capability binding → bridge contract → conformant deployment-local
bridge → business-shaped MCP
\`\`\`

## Refine one exact candidate

Export a content-addressed harness task, assess the untrusted submission, then
record a separate human decision:

\`\`\`bash
anvil legacy refine task legacy.inventory.json <lc_candidate_id> --out task.json
anvil legacy refine review legacy.inventory.json task.json submission.json --out review.json
anvil legacy refine approve legacy.inventory.json review.json \\
  --reviewer <identity> --reason <reviewed-reason> --out binding.json
\`\`\`

Use \`reject\` instead of \`approve\` to retain a content-addressed rejection.
The TypeScript SDK exposes \`createLegacyRefinementTask\`,
\`createLegacyRefinementProposal\`, \`assessLegacyRefinementProposal\`,
\`createLegacyReviewReceipt\`, and \`createReviewedLegacyCapabilityBinding\`
from \`@anvil/compiler/legacy\`.

A proposal must resolve every conflict using captured evidence and separately
define the business operation, clear input/output schemas, stable error codes,
pagination when needed, exact transport target, completion meaning,
authorization, idempotency, and retry policy. Anvil refuses generic middleware
tools, vague fields such as \`val\`, UI state such as \`showButton\`, invented
targets, unknown completion/auth decisions, and unsafe automatic retries.

Approval emits a reviewed binding with runtime status \`not_implemented\`. It
does not claim that a WebLogic, WebSphere, JBoss, IBM MQ, or .NET bridge exists.

Plan the bridge contract only after approval:

\`\`\`bash
anvil legacy bridge plan binding.json --out bridge-plan.json
\`\`\`

Add \`--driver driver.json\` to statically assess a descriptor. The CLI never
loads the driver, connects to the estate, accepts credentials, generates bridge
code, or treats contract compatibility as passed conformance or live readiness.
SDK users can call \`planLegacyBridge\` and \`assessLegacyBridgeDriver\` from
\`@anvil/compiler/legacy\` under the same boundary.

Never replace that last surface with generic \`consume_queue\`, \`put_message\`,
\`invoke_any_ejb\`, or \`call_any_mbean\` tools. Broker acknowledgement means
accepted by the transport; it does not mean the business work completed.
`;
}
