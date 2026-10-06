import {
  COMPOSE_FLOW_SCHEMA,
  type ComposeCatalog,
  type ComposeSource,
  composeCatalog,
} from "./catalog.js";
import { pythonCompositeFiles } from "./python.js";
import { typescriptCompositeFiles } from "./typescript.js";

export * from "./catalog.js";

/**
 * The composite: what `anvil connectors compose` writes (ADR-0031).
 *
 * ```text
 * <composite>/
 *   SKILL.md          when and how to span connectors with a flow
 *   compose.json      the catalog (anvil.compose-catalog/v1)
 *   python/anvil_compose/   Composite, Flow, python -m anvil_compose
 *   typescript/src/   the same, importing each connector's TypeScript SDK
 * ```
 */
export function generateComposite(sources: readonly ComposeSource[]): Record<string, string> {
  const catalog = composeCatalog(sources);
  return {
    "compose.json": `${JSON.stringify(catalog, null, 2)}\n`,
    "SKILL.md": compositeSkill(catalog),
    ...pythonCompositeFiles(catalog),
    ...typescriptCompositeFiles(catalog),
  };
}

function exampleFlow(catalog: ComposeCatalog): string {
  const reads = catalog.connectors.flatMap((c) =>
    c.operations.filter((op) => op.effect === "read").map((op) => ({ c, op })),
  );
  const writes = catalog.connectors.flatMap((c) =>
    c.operations
      .filter((op) => op.effect === "mutation" && op.effectClass !== "irreversible")
      .map((op) => ({ c, op })),
  );
  const first = reads[0];
  const then = writes.find((w) => w.c.id !== first?.c.id) ?? writes[0];
  const args = (op: (typeof reads)[number]["op"]) =>
    Object.fromEntries(op.inputs.filter((i) => i.required).map((i) => [i.key, `<${i.key}>`]));
  const steps: unknown[] = [];
  if (first) steps.push({ id: "find", operation: first.op.id, args: args(first.op) });
  if (then) {
    const thenArgs: Record<string, unknown> = args(then.op);
    steps.push({
      id: "act",
      operation: then.op.id,
      args: thenArgs,
      ...(first ? { after: ["find"] } : {}),
      ...(then.op.confirm ? { confirm: true } : {}),
    });
  }
  return JSON.stringify({ schema: COMPOSE_FLOW_SCHEMA, name: "example", steps }, null, 2);
}

function compositeSkill(catalog: ComposeCatalog): string {
  const rows = catalog.connectors.map((c) => {
    const reads = c.operations.filter((op) => op.effect === "read").length;
    return `| \`${c.id}\` | ${c.title} | ${reads} read, ${c.operations.length - reads} write | \`../${c.id}/SKILL.md\` |`;
  });
  return `---
name: compose
description: Use when one task spans several connectors (${catalog.connectors.map((c) => c.id).join(", ")}), reading from one and acting in another, as a flow, a DAG of calls you can plan, check and dry-run before anything is sent.
---

# Composing connectors

One object holds every connector below, and a **flow** is a DAG of their
calls: each step is one operation, and a step that reads another step's
result depends on it. Every step is an ordinary call to that connector's own
SDK, so its approval, confirmation, idempotency rules and this branch's
grant apply exactly as they do when you call the connector directly.

| Connector | Service | Operations | Its own skill |
| --- | --- | --- | --- |
${rows.join("\n")}

## Meta methods

| Method | What it does | Sends anything? |
| --- | --- | --- |
| \`flow.step(id, operation, args, ...)\` | Add one call. A \`ref(step, path)\` input makes it depend on \`step\`. | no |
| \`flow.map(id, operation, over, args)\` | One call per element of a list result; \`item(path)\` is the element. | no |
| \`when=ref(...).equals(v)\` / \`.exists()\` | Run the step only if the condition holds. | no |
| \`flow.plan()\` | The DAG: nodes, edges, waves, effect of each step. | no |
| \`flow.validate()\` | Findings; any \`error\` stops \`run()\` before a call. | no |
| \`flow.dry_run()\` | Every step through its gates with \`dry_run\`. | no |
| \`flow.run()\` | Steps in dependency order; stops at the first failure. | yes |
| \`flow.compensate(run, confirm=...)\` | Runs the undo calls a failed run lists. Only when you call it. | yes |

## Python

\`\`\`python
import sys; sys.path.insert(0, "<this directory>/python")
from anvil_compose import Composite, ref, item

c = Composite()                       # gateway mode is picked up from the environment
flow = c.flow("example")
found = flow.step("find", "<operation id>", {...})
flow.step("act", "<operation id>", {"field": ref(found, "[0].id")}, confirm=True)
print(flow.plan()); print(flow.validate())
run = flow.run()
if not run.ok: print(run.compensation)   # resolved undo calls; nothing has been undone
\`\`\`

Or drive a flow document from the shell, with
\`PYTHONPATH=<this directory>/python python -m anvil_compose\`:
\`validate FLOW.json\`, \`plan FLOW.json\`, \`run FLOW.json --dry-run\`, \`run FLOW.json\`.

## TypeScript

\`typescript/src/index.ts\` exports the same \`Composite\`, \`ref\`, \`item\`
(\`flow.dryRun()\` and \`flow.run()\` return promises).

## A flow document (\`${COMPOSE_FLOW_SCHEMA}\`)

\`\`\`json
${exampleFlow(catalog)}
\`\`\`

An input value \`{"$ref": "<step>", "path": "[0].id"}\` reads an earlier
step's result; \`{"$item": "id"}\` reads the element inside a map step
(\`"for_each": {"$ref": "<step>"}\`). An operation id is enough to name an
operation; when two connectors share one, add \`"connector"\`.

## Rules

- \`plan()\` and \`validate()\` first; \`dry_run()\` before the first real run.
- Set \`confirm\` on a step only when the task asks for that step's effect;
  \`validate()\` refuses a step that needs it and does not have it.
- A step whose effect is irreversible is flagged by \`validate()\`: if a later
  step fails, nothing takes that one back. Put irreversible writes last.
- A failed run lists what would undo each completed write. Undoing is a
  decision: call \`compensate()\` only when the task wants it, and report
  every entry it could not undo.
`;
}
