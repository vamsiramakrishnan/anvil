import { describe, expect, it } from "vitest";
import { AirDocument } from "./schema.js";
import { airFromJson, airFromYaml, airToYaml, loadAirDocument } from "./serialize.js";
import {
  AIR_VERSION,
  type AirMigration,
  AirVersionError,
  airCompatibility,
  assertAirCompatible,
  migrateAir,
} from "./version.js";

/**
 * The format-version gate. Asymmetric like every other gate: a newer MAJOR
 * version is refused with a typed code, everything else is read — an older
 * document with a warning, so the operator hears that a recompile is due
 * rather than discovering it in a diff.
 */

const minimal = () => ({
  service: {
    id: "svc",
    version: "1.0.0",
    source: { kind: "openapi", uri: "spec.yaml" },
  },
});

describe("AIR_VERSION", () => {
  it("equals the schema default so a compile and the gate never disagree", () => {
    expect(AirDocument.parse(minimal()).anvilVersion).toBe(AIR_VERSION);
  });
});

describe("airCompatibility", () => {
  it("names the four non-current verdicts", () => {
    expect(airCompatibility("0.1.0", "0.1.0").verdict).toBe("current");
    expect(airCompatibility("0.0.9", "0.1.0").verdict).toBe("older");
    expect(airCompatibility("0.2.0", "0.1.0").verdict).toBe("newer_minor");
    expect(airCompatibility("0.1.1", "0.1.0").verdict).toBe("newer_minor");
    expect(airCompatibility("1.0.0", "0.1.0").verdict).toBe("newer_major");
    expect(airCompatibility("next", "0.1.0").verdict).toBe("unparseable");
  });
});

describe("assertAirCompatible", () => {
  it("refuses a newer major version with a typed error code", () => {
    let caught: unknown;
    try {
      assertAirCompatible({
        ...minimal(),
        anvilVersion: `${Number(AIR_VERSION.split(".")[0]) + 1}.0.0`,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AirVersionError);
    expect((caught as AirVersionError).code).toBe("air/incompatible_version");
    expect((caught as AirVersionError).message).toMatch(/upgrade anvil/);
  });

  it("refuses a version it cannot parse rather than guessing", () => {
    expect(() => assertAirCompatible({ ...minimal(), anvilVersion: "latest" })).toThrow(
      AirVersionError,
    );
  });

  it("treats an absent version as the schema default", () => {
    expect(assertAirCompatible(minimal()).verdict).toBe("current");
  });
});

describe("the loaders", () => {
  it("refuse a newer-major document from YAML and JSON alike", () => {
    const doc = { ...minimal(), anvilVersion: "99.0.0" };
    expect(() => airFromJson(JSON.stringify(doc))).toThrow(AirVersionError);
    expect(() =>
      airFromYaml(
        `anvilVersion: "99.0.0"\nservice:\n  id: svc\n  version: 1.0.0\n  source:\n    kind: openapi\n    uri: spec.yaml\n`,
      ),
    ).toThrow(AirVersionError);
  });

  it("warn on an older document and still return it", () => {
    const warnings: string[] = [];
    const doc = airFromJson(JSON.stringify({ ...minimal(), anvilVersion: "0.0.1" }), {
      onWarning: (message) => warnings.push(message),
    });
    expect(doc.anvilVersion).toBe("0.0.1");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/older than this toolchain/);
  });

  it("say nothing for a current document", () => {
    const warnings: string[] = [];
    const yaml = airToYaml(AirDocument.parse(minimal()));
    airFromYaml(yaml, { onWarning: (message) => warnings.push(message) });
    expect(warnings).toEqual([]);
  });
});

describe("migrateAir", () => {
  it("is a pass-through with the empty registry", () => {
    const raw = minimal();
    expect(migrateAir(raw)).toBe(raw);
  });

  it("applies a registered migration to the raw document before validation", () => {
    const migration: AirMigration = {
      id: "lift-legacy-title",
      appliesTo: (version) => version === "0.0.1",
      apply: (raw) => {
        const { legacyTitle, ...rest } = raw as { legacyTitle: string; service: object };
        return {
          ...rest,
          anvilVersion: AIR_VERSION,
          service: { ...rest.service, displayName: legacyTitle },
        };
      },
    };
    const raw = { ...minimal(), anvilVersion: "0.0.1", legacyTitle: "Legacy" };
    const doc = loadAirDocument(raw, { migrations: [migration] });
    expect(doc.service.displayName).toBe("Legacy");
    expect(doc.anvilVersion).toBe(AIR_VERSION);
    // A migration that does not apply leaves the document alone.
    expect(migrateAir(minimal(), { migrations: [migration] })).toEqual(minimal());
  });
});
