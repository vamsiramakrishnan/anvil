import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { AirDocument } from "./schema.js";

/** Validate and normalize an arbitrary object into a canonical AirDocument. */
export function loadAirDocument(data: unknown): AirDocument {
  return AirDocument.parse(data);
}

/** Parse an AIR document from YAML text (defaults applied, structure validated). */
export function airFromYaml(text: string): AirDocument {
  return loadAirDocument(parseYaml(text));
}

/** Parse an AIR document from JSON text. */
export function airFromJson(text: string): AirDocument {
  return loadAirDocument(JSON.parse(text));
}

/** Serialize an AIR document to canonical YAML (the on-disk `air.yaml`). */
export function airToYaml(air: AirDocument): string {
  return stringifyYaml(AirDocument.parse(air), { lineWidth: 100 });
}

/** Serialize an AIR document to pretty JSON. */
export function airToJson(air: AirDocument): string {
  return `${JSON.stringify(AirDocument.parse(air), null, 2)}\n`;
}
