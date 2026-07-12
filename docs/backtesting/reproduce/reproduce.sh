#!/usr/bin/env bash
# Reproduce any backtest from scratch: fetch the REAL vendor spec, trim it to
# the curated subset, and compile it through Anvil with the authored manifest.
#
# The vendor specs are deliberately NOT committed to this repo — they are large
# (Stripe alone is 2MB), not Anvil's code, and fully reproducible from their
# public URLs. What IS committed is the *recipe*: the spec URL, the curated
# operation list, the trim scripts, and the safety manifest — everything needed
# to regenerate a backtest bundle byte-for-byte.
#
# Usage:
#   docs/backtesting/reproduce/reproduce.sh <system>     # one system
#   docs/backtesting/reproduce/reproduce.sh all          # every system
#
# Env:
#   WORK=<dir>       work directory (default: mktemp -d)
#   PREPARE_ONLY=1   fetch + trim only; skip `anvil source add` / `anvil compile`.
#                    Leaves the prepared input at $WORK/<system>.spec.json (REST)
#                    or $WORK/<system>.graphql / $WORK/<system>.proto. Used by the
#                    corpus harness (tools/corpus) to time compilation separately
#                    from network fetch.
#
# Requires: a built repo (`pnpm build`) and network access.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
ANVIL="node $ROOT/packages/cli/dist/bin-anvil.js"
WORK="${WORK:-$(mktemp -d)}"
mkdir -p "$WORK"
TSV="$HERE/systems.tsv"

# YAML → JSON (the openapi3 trimmer takes JSON); uses the compiler's own parser.
# Dispatch on *content*, not filename — fetched specs land as <system>.raw
# regardless of whether the vendor publishes JSON or YAML.
to_json () {
  local in="$1" out="$2"
  if [ "$(head -c 1024 "$in" | tr -d '[:space:]' | cut -c1)" = "{" ]; then
    cp "$in" "$out"
  else
    node --input-type=module -e "
      import { readFileSync, writeFileSync } from 'node:fs';
      const C = await import('$ROOT/packages/compiler/dist/index.js');
      writeFileSync('$out', JSON.stringify(C.parseSourceText(readFileSync('$in','utf8')).doc));
    "
  fi
}

reproduce_one () {
  local sys="$1"
  local line; line="$(grep -vE '^#' "$TSV" | awk -F'\t' -v s="$sys" '$1==s')"
  [ -n "$line" ] || { echo "unknown system: $sys" >&2; return 1; }
  local fmt url list trimmer
  fmt="$(echo "$line" | cut -f2)"; url="$(echo "$line" | cut -f3)"
  list="$(echo "$line" | cut -f4)"; trimmer="$(echo "$line" | cut -f5)"

  # Non-REST protocols (GraphQL SDL, proto) are compiled as-is: no JSON
  # conversion, no path trim — the adapter lowers the raw schema directly.
  if [ "$fmt" = "graphql" ] || [ "$fmt" = "protobuf" ]; then
    local ext="graphql"; [ "$fmt" = "protobuf" ] && ext="proto"
    local raw="$WORK/$sys.$ext"
    echo "→ $sys ($fmt): fetching $url"
    curl -fsSL "$url" -o "$raw"
    if [ "${PREPARE_ONLY:-0}" = "1" ]; then echo "   prepared → $raw"; return 0; fi
    local sid; sid="$($ANVIL source add "$raw" --root "$WORK" 2>&1 | grep -oE 'src-[0-9a-f]+' | head -1)"
    local manifest="$HERE/manifests/$sys.anvil.yaml"
    local margs=(); [ -f "$manifest" ] && margs=(--manifest "$manifest")
    $ANVIL compile --source "$sid" --root "$WORK" "${margs[@]}" --service "$sys" --out "$WORK/generated/$sys" | sed 's/^/   /'
    echo "   bundle → $WORK/generated/$sys"
    return 0
  fi

  local raw="$WORK/$sys.raw" spec="$WORK/$sys.spec.json"
  echo "→ $sys: fetching $url"
  curl -fsSL "$url" -o "$raw"

  if [ "$trimmer" = "none" ]; then
    to_json "$raw" "$spec"
  elif [ "$trimmer" = "swagger2" ]; then
    cp "$raw" "$spec.tmp"; node "$HERE/trim/swagger2.mjs" "$spec.tmp" "$HERE/$list" "$spec" "$sys (curated)"
  elif [ "$trimmer" = "discovery" ]; then
    node "$HERE/trim/discovery.mjs" "$raw" "$HERE/$list" "$spec"
  else # openapi3
    to_json "$raw" "$spec.tmp"; node "$HERE/trim/openapi3.mjs" "$spec.tmp" "$HERE/$list" "$spec" "$sys (curated)"
  fi

  if [ "${PREPARE_ONLY:-0}" = "1" ]; then echo "   prepared → $spec"; return 0; fi

  local sid; sid="$($ANVIL source add "$spec" --root "$WORK" 2>&1 | grep -oE 'src-[0-9a-f]+' | head -1)"
  local manifest="$HERE/manifests/$sys.anvil.yaml"
  local margs=(); [ -f "$manifest" ] && margs=(--manifest "$manifest")
  $ANVIL compile --source "$sid" --root "$WORK" "${margs[@]}" --service "$sys" --out "$WORK/generated/$sys" | sed 's/^/   /'
  echo "   bundle → $WORK/generated/$sys"
}

if [ "${1:-}" = "all" ]; then
  grep -vE '^#' "$TSV" | cut -f1 | while read -r s; do reproduce_one "$s"; done
else
  reproduce_one "${1:?usage: reproduce.sh <system|all>}"
fi
