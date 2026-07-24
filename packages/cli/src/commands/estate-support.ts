import {
  GATEWAY_SUPPORT_REGISTRY_VERSION,
  type GatewaySupportContract,
  GatewaySupportVendor,
  gatewaySupportContract,
  gatewaySupportRegistry,
} from "@anvil/compiler";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

interface EstateSupportOptions {
  json?: boolean;
}

const TIER_LABELS: Record<GatewaySupportContract["releaseTier"], string> = {
  native_estate: "native estate",
  native_single_artifact: "native single artifact",
  normalized_interchange: "normalized interchange",
  research_only: "research only",
};

function list(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function acceptedInputSummary(contract: GatewaySupportContract): string {
  return contract.acceptedInputs.length > 0
    ? contract.acceptedInputs.map((input) => input.description).join(" ")
    : "No input is accepted by estate inventory/import.";
}

function renderContract(contract: GatewaySupportContract): string {
  const semantic = contract.semantics
    .filter((entry) => entry.level !== "none")
    .map((entry) => `${entry.dimension}=${entry.level}`)
    .join(", ");
  const authority = contract.authorityEvidence
    .filter((entry) => entry.level !== "none")
    .map((entry) => `${entry.dimension}=${entry.level}`)
    .join(", ");
  return [
    `${contract.displayName} — ${TIER_LABELS[contract.releaseTier]}`,
    contract.summary,
    "",
    `Accepted input: ${acceptedInputSummary(contract)}`,
    `Required coordinates: ${list(contract.coordinates.required)}`,
    `Conditional coordinates: ${list(contract.coordinates.conditional)}`,
    `Unavailable coordinates: ${list(contract.coordinates.unavailable)}`,
    `Coordinate boundary: ${contract.coordinates.boundary}`,
    "",
    `Route semantics: ${contract.contractBinding.routeSemantics}`,
    `Formal contract: ${contract.contractBinding.formalContract}`,
    `Lineage policy: ${contract.contractBinding.lineagePolicy}`,
    contract.contractBinding.boundary,
    "",
    `Modeled semantics: ${semantic || "none"}`,
    `Authority evidence: ${authority || "none"}`,
    `Scale proof: ${contract.scaleProof.kind}; ${contract.scaleProof.apiCount} APIs. ${contract.scaleProof.statement}`,
    `Fixture provenance: ${contract.fixtureProvenance.kind}. ${contract.fixtureProvenance.statement}`,
    "",
    "Opaque / unsupported boundaries:",
    ...contract.opaqueBoundaries.map((boundary) => `  - ${boundary}`),
    "",
    "Known gaps:",
    ...contract.knownGaps.map((gap) => `  - ${gap}`),
    "",
    "Primary references:",
    ...contract.officialReferences.map((reference) => `  - ${reference.title}: ${reference.url}`),
  ].join("\n");
}

function renderRegistry(): string {
  const registry = gatewaySupportRegistry();
  return [
    `Gateway support registry ${GATEWAY_SUPPORT_REGISTRY_VERSION}`,
    "Release tier describes accepted bytes; semantic coverage and test provenance are separate claims.",
    "",
    ...registry.contracts.map(
      (contract) =>
        `${contract.displayName.padEnd(38)} ${TIER_LABELS[contract.releaseTier].padEnd(24)} ${acceptedInputSummary(contract)}`,
    ),
    "",
    "Use `anvil estate support <vendor>` for boundaries, proof, and primary references.",
    "Use `anvil estate support --json` as the release/CI support contract.",
  ].join("\n");
}

export function registerEstateSupport(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("support")
      .summary("Show the versioned native-vs-normalized gateway support contract.")
      .description(
        "Reports what artifact shapes Anvil actually accepts, separately from the semantics an adapter models and the fixtures/scale proof behind that claim. Mashery is research-only and is not selectable by inventory/import.",
      )
      .argument(
        "[vendor]",
        `one gateway (${GatewaySupportVendor.options.join(" | ")}); omit to list every contract`,
      )
      .option("--json", "emit the stable machine-readable support registry")
      .action((vendor: string | undefined, opts: EstateSupportOptions) => {
        ctx.code = runEstateSupport(vendor, opts, ctx.io);
      }),
    { mutates: false },
  );
}

export function runEstateSupport(
  vendor: string | undefined,
  opts: EstateSupportOptions,
  io: CliIO,
): number {
  const parsed = vendor === undefined ? undefined : GatewaySupportVendor.safeParse(vendor);
  if (parsed && !parsed.success) {
    const message = `Unknown gateway support vendor '${vendor}'. Use: ${GatewaySupportVendor.options.join(" | ")}.`;
    if (opts.json) {
      io.out(
        JSON.stringify(
          {
            schemaVersion: 1,
            reportType: "anvil.gateway-support-error",
            registryVersion: GATEWAY_SUPPORT_REGISTRY_VERSION,
            code: "gateway_support/unknown_vendor",
            message,
          },
          null,
          2,
        ),
      );
    } else {
      io.err(message);
    }
    return 1;
  }

  if (opts.json) {
    const registry = gatewaySupportRegistry();
    io.out(
      JSON.stringify(
        parsed?.success
          ? {
              ...registry,
              contracts: [gatewaySupportContract(parsed.data)],
            }
          : registry,
        null,
        2,
      ),
    );
    return 0;
  }

  io.out(parsed?.success ? renderContract(gatewaySupportContract(parsed.data)) : renderRegistry());
  return 0;
}
