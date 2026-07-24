import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { runDetectors } from "@anvil/refinement";
import { describe, expect, it } from "vitest";
import { generateBundle } from "./bundle.js";
import { certifyBundle } from "./certify.js";

const example = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/payments/${name}`, import.meta.url)),
    "utf8",
  );

describe("UI-projection findings and certification", () => {
  it("does not block an ordinary domain list merely because its payload has UI-adjacent fields", async () => {
    const air = await compile({
      spec: example("openapi.yaml"),
      manifest: example("anvil.yaml"),
      serviceId: "payments",
    });
    const read = air.operations.find(
      (operation) => operation.state === "approved" && operation.effect.kind === "read",
    );
    if (!read) throw new Error("fixture approved read missing");

    read.sourceRef.path = "/applications";
    read.effect.action = "list";
    read.effect.resource = "application";
    read.output.schema = {
      type: "object",
      properties: {
        columns: { type: "array", items: { type: "string" } },
        pageTitle: { type: "string" },
        items: { type: "array", items: { type: "object" } },
      },
    };

    expect(
      runDetectors(air).filter(
        (finding) =>
          finding.code === "ui_projection_contract" &&
          "operationId" in finding.target &&
          finding.target.operationId === read.id,
      ),
    ).toEqual([]);

    const certification = certifyBundle(generateBundle(air).files, air);
    expect(certification.status).toBe("passed");
    expect(
      certification.checks.find((check) => check.id === "semantic.no-blocked-disposition")?.status,
    ).toBe("passed");
  });
});
