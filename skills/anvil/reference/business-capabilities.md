---
name: anvil-business-capabilities
description: Author, review, compile, and calibrate business actions with a private execution plan and aligned agent surfaces.
---

# Business capability execution

Read this when an agent needs business outcomes that span approved API operations.

1. Author independent business input and result schemas. Describe intent,
   counter-intent, clarification, effects, and escalation.
2. Bind every fact and effect to an explicitly approved source operation.
   Record why that source is authoritative. Never infer cross-system identity
   from similar field names.
3. Keep deterministic API choreography in the private plan. Use skills to choose
   actions and handle decisions that need judgment.
4. Compile into a new directory:

```sh
anvil capability compile <definition.json> --source orders=<bundle> billing=<bundle> --out <new-directory>
anvil capability preview <new-directory>
anvil capability preview <new-directory> --execution
```

The default preview is the agent view. The execution view is operator-only.
Neither executes operations or approves them. Actions default to proposed;
review the complete definition and source authority before marking them approved.
Change the definition and recompile; editing only generated public AIR is drift.

The public MCP, CLI, TypeScript, Python, Go, and Java surfaces call one shared
business gateway. Configure verified caller identity, tenant, policy version,
source credentials and grants, and the durable execution ledger before serving.
Tool arguments cannot supply trusted execution context.

Human approval is enforced by a trusted runtime hook or operator-managed approval
store, bound to the exact request and intent. A model's confirm boolean is not
human approval. Do not write approval records on the user's behalf without
authorization for the specific effects.

Inspect status before declaring success. For partial or uncertain completion,
report completed effects and the next action, preserve the intent key, and give
the capability owner the trace identifier. Never restart a journey or rotate
its key to get around uncertainty. Composition does not make APIs transactional.

Keep the full deployment bundle private: generation.json and runtime/business.plan.json
contain source AIR and execution details. Package the generated skill for agents.

Calibrate with independent business-state fixtures and actual generated clients.
Then evaluate selection, grounded arguments, and business outcomes with the real
agent harness. Fewer tools or lexical routing scores alone do not establish better
agent performance. Repository examples and tests live in examples/business and
packages/harness/src/business; the complete guide is docs/business-capabilities.md.

For versioned workspaces, use capability project save/list/show/build/evaluate/jobs.
Save requires the prior revision digest; build and evaluate require the current one.
The console's Business capabilities view uses the same services. Import project
JSON, review each action, validate its public/private preview, then save and build.
Evaluation adapters are operator-owned local modules. Compare raw/business/
business-skill lanes with equal task, fixture seed, model configuration, and budgets.
Inspect independent backend outcomes; a completed agent or worker is not success.
Unsupported or inconclusive trials are not passes. See docs/business-workbench.md.

ANVIL_BUSINESS_JOURNAL_DIR records attempted steps, response digests, and final
status. Use capability execution inspect/reconcile with the latest record digest
and an authoritative verifier. Reconciliation records findings; it never replays
writes, clears intent reservations, or turns unknown effects into success.

Existing capability compose remains an audit-only overlap review. It does not
become executable choreography by renaming its output.
