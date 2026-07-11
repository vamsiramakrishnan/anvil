import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { AirDocument } from "./schema.js";

/** Validate and normalize an arbitrary object into a canonical AirDocument. */
export function loadAirDocument(data: unknown): AirDocument {
  return AirDocument.parse(data);
}

/** Parse an AIR document from YAML text (defaults applied, structure validated). */
export function airFromYaml(text: string): AirDocument {
  // The AIR is Anvil's OWN trusted, self-generated document — not an untrusted
  // upload. A large bundle legitimately repeats sub-structures (shared retry
  // condition lists, error shapes, schema fragments), and the `yaml` parser's
  // default anti-"billion laughs" cap of 100 aliases would reject a perfectly
  // valid bundle: PagerDuty's real 465-operation AIR serialized to 110 aliases,
  // so `anvil lint`/`certify` — which re-read air.yaml — failed on their own
  // output. Lift the cap for this trusted parse only; untrusted specs and
  // manifests are parsed elsewhere (parse.ts, manifest.ts) and keep the default
  // protection. Combined with `aliasDuplicateObjects: false` in `airToYaml`,
  // freshly generated bundles carry no aliases at all — this keeps already
  // written (or older) bundles loadable too.
  return loadAirDocument(parseYaml(text, { maxAliasCount: -1 }));
}

/** Parse an AIR document from JSON text. */
export function airFromJson(text: string): AirDocument {
  return loadAirDocument(JSON.parse(text));
}

/** Serialize an AIR document to canonical YAML (the on-disk `air.yaml`). */
export function airToYaml(air: AirDocument): string {
  // `aliasDuplicateObjects: false` — never emit YAML anchors/aliases for
  // repeated objects. The canonical air.yaml must be self-contained and
  // human-diffable (an `*alias` pointing elsewhere in a 20k-line file is
  // unreadable), and must re-parse without tripping the parser's alias-count
  // safety cap. This is what makes the serialize→parse round-trip robust on a
  // large bundle, not just the raised cap on the read side.
  return stringifyYaml(AirDocument.parse(air), { lineWidth: 100, aliasDuplicateObjects: false });
}

/** Serialize an AIR document to pretty JSON. */
export function airToJson(air: AirDocument): string {
  return `${JSON.stringify(AirDocument.parse(air), null, 2)}\n`;
}
