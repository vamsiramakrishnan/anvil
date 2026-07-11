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
# Requires: a built repo (`pnpm build`) and network access.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
ANVIL="node $ROOT/packages/cli/dist/bin-anvil.js"
WORK="${WORK:-$(mktemp -d)}"
mkdir -p "$WORK"
TSV="$HERE/systems.tsv"

# YAML → JSON (the openapi3 trimmer takes JSON); uses the compiler's own parser.
to_json () {
  local in="$1" out="$2"
  case "$in" in
    *.yaml|*.yml)
      node --input-type=module -e "
        import { readFileSync, writeFileSync } from 'node:fs';
        const C = await import('$ROOT/packages/compiler/dist/index.js');
        writeFileSync('$out', JSON.stringify(C.parseSourceText(readFileSync('$in','utf8')).doc));
      " ;;
    *) cp "$in" "$out" ;;
  esac
}

reproduce_one () {
  local sys="$1"
  local line; line="$(grep -vE '^#' "$TSV" | awk -F'\t' -v s="$sys" '$1==s')"
  [ -n "$line" ] || { echo "unknown system: $sys" >&2; return 1; }
  local fmt url list trimmer
  fmt="$(echo "$line" | cut -f2)"; url="$(echo "$line" | cut -f3)"
  list="$(echo "$line" | cut -f4)"; trimmer="$(echo "$line" | cut -f5)"

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
