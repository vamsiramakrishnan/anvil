# Reproducing the backtests

The fifteen backtested systems compile from **real, published vendor specs**.
Those specs are deliberately **not committed** — they are large (Stripe alone
is 2 MB), they are not Anvil's own code, and they are fully reproducible from
their public URLs. Committing ~4.6 MB of third-party OpenAPI documents into the
core tree is pollution; what belongs in the repo is the *recipe*, not the
vendor bytes.

So this directory holds everything needed to regenerate any backtest
byte-for-byte, and nothing else:

- **`systems.tsv`** — for each system: format, the exact public spec URL, the
  curated operation/path list, and which trimmer to use.
- **`curated/`** — the curated operationId / path lists (the representative
  subset that overlaps each system's mature reference MCP).
- **`trim/`** — the three trimmers that reduce a full vendor spec to its
  curated subset while keeping every transitively-referenced schema verbatim:
  `openapi3.mjs` (OpenAPI 3 `#/components/schemas`), `swagger2.mjs` (Swagger 2.0
  `#/definitions` + shared `parameters`/`responses`), `discovery.mjs` (Google
  Discovery → the same subset shape).
- **`manifests/`** — the authored Anvil safety manifests (`<system>.anvil.yaml`).
  These are the real, hand-authored knowledge: which operations are
  non-idempotent, which need confirmation, which are naturally idempotent. Small
  and worth keeping; meaningless without the spec, which the recipe fetches.
- **`reproduce.sh`** — ties it together: fetch → trim → `anvil compile`.

## Run it

```bash
pnpm build                                   # once
docs/backtesting/reproduce/reproduce.sh notion     # one system
docs/backtesting/reproduce/reproduce.sh all        # every system
```

GraphQL (`github_gql`, `linear`) and single-file gRPC (`temporal`) are compiled
from the raw schema as-is — no trim — since the adapters lower the whole schema.

### Multi-file gRPC (etcd) — proving cross-file message resolution

A real gRPC service splits its request/response messages across imported
`.proto` files. `anvil source add` all of them (entrypoint + imports, with their
import-relative paths preserved) and the proto adapter resolves them into one
root (finding #22):

```bash
cd "$(mktemp -d)" && B=https://raw.githubusercontent.com/etcd-io/etcd/main/api
mkdir -p etcd/api/{mvccpb,authpb,versionpb}
curl -fsSLO "$B/etcdserverpb/rpc.proto"
curl -fsSL "$B/mvccpb/kv.proto"        -o etcd/api/mvccpb/kv.proto
curl -fsSL "$B/authpb/auth.proto"      -o etcd/api/authpb/auth.proto
curl -fsSL "$B/versionpb/version.proto" -o etcd/api/versionpb/version.proto
anvil source add rpc.proto etcd/api/mvccpb/kv.proto etcd/api/authpb/auth.proto etcd/api/versionpb/version.proto
anvil compile --source <id> --entrypoint rpc.proto --service etcd --out generated/etcd
# `Put` now resolves key,value,lease,prev_kv,…; the imported KeyValue message resolves too.
```

etcd has no mature MCP, so it is the adapter/multi-file specimen, not an
MCP-comparison target (see `../protocols-real.md`).

Each run fetches the live spec, trims it, and compiles a full bundle into a
temp dir — the same loop the backtests documented in `../*.md` used. If a
vendor moves a spec URL, update its row in `systems.tsv`; nothing else changes.

## Why this is enough

Every compiler fix the backtests produced (findings #1–#19 in
`../deficiencies.md`) lives in the **compiler core** and is pinned by a **small
synthetic test** — not by any vendor spec. The specs were the discovery
vehicle; the mechanisms and their tests are the record. That is exactly why the
specs can be removed without weakening the guarantees: re-fetching them proves
the backtest still holds, but the day-to-day correctness is guarded by the unit
tests, which need no network and no multi-megabyte fixtures.
