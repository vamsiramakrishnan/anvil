# Legacy GitHub corpus

This harness answers a narrow but important question: when Anvil sees artifacts
from real WebLogic, WebSphere, WildFly, WCF, IBM MQ, Artemis, RabbitMQ, Kafka,
Kafka Connect, Strimzi, and AsyncAPI projects, what does it actually recover?

The corpus is intentionally honest about both successes and gaps. A known
unsupported format is a passing benchmark case when Anvil reports that state
deterministically. The gate fails when behavior drifts without review, an input
changes at its pinned Git commit, the CLI crashes, or the same input produces a
different report on its second run.

## Run it

Build Anvil once, then run the network-gated corpus:

```bash
pnpm build
pnpm corpus:legacy
```

Useful options:

```bash
pnpm corpus:legacy -- --systems wcf-msmq,ibm-mq-ccdt
pnpm corpus:legacy -- --work /tmp/anvil-corpus-runs
pnpm corpus:legacy -- --cli /path/to/packages/cli/dist/bin-anvil.js
```

`--work` names a parent directory. The harness creates a new uniquely named
child and keeps it for inspection. Without `--work`, downloaded inputs are
deleted after the run.

Results are written to the gitignored `report/` directory as JSON and Markdown.

## What is gated

Every row in `systems.json` pins:

- the GitHub repository, full 40-character commit, and exact source path;
- a SHA-256 digest of the fetched bytes;
- license evidence at the same revision;
- the expected collector, exit code, candidate/conflict counts, diagnostic
  codes, and support classification.

The runner fetches at most 4 MiB per case, verifies the digest before writing a
temporary file, invokes the public `anvil legacy inventory` CLI twice, and
requires byte-identical reports. It also rejects a run when the CLI output
contains credential, user, permission, or authentication-secret field names.

| Classification | Meaning |
| --- | --- |
| `supported` | Anvil produced actionable candidates without an error or warning. |
| `partial` | Anvil recovered candidates but retained a material warning or conflict. |
| `unsupported` | Anvil produced no candidate; the limitation is deliberately pinned. |
| `safety-refusal` | Anvil rejected an unsafe or secret-bearing input as designed. |
| `crash` | The CLI timed out, died, or failed to emit its structured report. Always a failure. |

## Third-party content policy

No third-party source file is committed to Anvil. The repository contains only
the reproducible recipe, cryptographic digest, behavioral oracle, and license
link. This keeps the codebase small and avoids silently redistributing legacy
application artifacts. Secret-bearing RabbitMQ examples are fetched into a
temporary directory solely to prove both safe topology projection and
fail-closed behavior when no topology can be projected. Their content is never
copied into a report.

## Updating an expectation

Do not refresh counts just to make a red run green. First explain whether the
change is a collector improvement, a deliberate diagnostic change, or a
regression. Then update the matching `expected` object and the findings in
`docs/backtesting/legacy-corpus.md` in the same reviewed commit.
