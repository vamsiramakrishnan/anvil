import { describe, expect, it } from "vitest";
import {
  gatewayIdentityRejection,
  type ImportPolicyInput,
  invalidGatewayId,
  resolveGatewayUrl,
  specOverrideReason,
  specOverrideRejection,
  suppliedContractRejection,
} from "./estate-import-policy.js";

/**
 * These rules were previously expressed inside `runImport` as *emit a message and
 * return 1*, so the only way to exercise "an attestation over a supplied contract
 * is defined only for WSO2" was to drive the whole CLI. They are policy about
 * gateway lineage, not about being a CLI, and this is what testing them directly
 * looks like.
 */

const base: ImportPolicyInput = { vendor: "wso2" };
const opts = (over: Partial<ImportPolicyInput> = {}): ImportPolicyInput => ({ ...base, ...over });

describe("attesting a supplied contract over the gateway's own definition", () => {
  it("permits the import when nothing is attested", () => {
    expect(specOverrideRejection(opts())).toBeUndefined();
    expect(specOverrideRejection(opts({ spec: "./api.yaml" }))).toBeUndefined();
  });

  it("refuses an attestation with no contract to attest", () => {
    expect(specOverrideRejection(opts({ attestSpecOverride: "reviewed" }))?.code).toBe(
      "gateway/spec_override_without_spec",
    );
  });

  it("refuses a vendor whose native definition lineage is not modelled", () => {
    for (const vendor of ["kong", "apigee", "mulesoft", "api_connect"]) {
      expect(
        specOverrideRejection(opts({ vendor, spec: "./api.yaml", attestSpecOverride: "reviewed" }))
          ?.code,
        vendor,
      ).toBe("gateway/spec_override_wrong_vendor");
    }
  });

  it("refuses a reason a reviewer cannot use", () => {
    const reject = (attestSpecOverride: string) =>
      specOverrideRejection(opts({ spec: "./api.yaml", attestSpecOverride }))?.code;
    expect(reject("")).toBe("gateway/invalid_spec_override_attestation");
    expect(reject("   \t \n ")).toBe("gateway/invalid_spec_override_attestation");
    expect(reject("x".repeat(2_001))).toBe("gateway/invalid_spec_override_attestation");
    // The boundary itself is accepted.
    expect(reject("x".repeat(2_000))).toBeUndefined();
  });

  it("checks in a fixed order, because the first refusal is what the caller sees", () => {
    // Everything is wrong at once. The missing contract is reported, not the
    // vendor or the empty reason — the order is part of the observed behaviour.
    expect(specOverrideRejection(opts({ vendor: "kong", attestSpecOverride: "" }))?.code).toBe(
      "gateway/spec_override_without_spec",
    );
    expect(
      specOverrideRejection(opts({ vendor: "kong", spec: "./api.yaml", attestSpecOverride: "" }))
        ?.code,
    ).toBe("gateway/spec_override_wrong_vendor");
  });

  it("carries the trimmed reason forward once accepted", () => {
    expect(specOverrideReason(opts({ attestSpecOverride: "  reviewed by SRE  " }))).toBe(
      "reviewed by SRE",
    );
    expect(specOverrideReason(opts())).toBeUndefined();
  });
});

describe("a supplied contract does not vouch for its own gateway", () => {
  it("requires an explicit gateway URL alongside --spec", () => {
    const rejection = suppliedContractRejection(opts({ spec: "./api.yaml" }));
    expect(rejection?.message).toContain("--gateway-url");
    // This refusal carried no machine-readable code until the operator-contract
    // work, which meant `--json` exited 1 with an empty stdout. An earlier
    // revision of this test pinned `code` as undefined; that characterisation
    // did its job by making the change deliberate rather than incidental.
    expect(rejection?.code).toBe("gateway/gateway_url_required");
  });

  it("is satisfied once the gateway is named", () => {
    expect(
      suppliedContractRejection(opts({ spec: "./api.yaml", gatewayUrl: "https://gw.example" })),
    ).toBeUndefined();
  });

  it("does not apply without --spec", () => {
    expect(suppliedContractRejection(opts())).toBeUndefined();
  });
});

describe("the public gateway URL recorded into the receipt", () => {
  const url = (gatewayUrl: string) => resolveGatewayUrl(opts({ gatewayUrl }));

  it("accepts an absolute HTTPS origin and normalizes its trailing slashes", () => {
    expect(url("https://gw.example/base/")).toEqual({ url: "https://gw.example/base" });
    expect(url("https://gw.example/base///")).toEqual({ url: "https://gw.example/base" });
    // A bare origin keeps its single root slash rather than losing it.
    expect(url("https://gw.example/")).toEqual({ url: "https://gw.example/" });
  });

  it("refuses plaintext, because the coordinate is a security claim", () => {
    expect(url("http://gw.example")).toMatchObject({
      rejection: { message: expect.stringContaining("must use HTTPS") },
    });
  });

  it("refuses embedded credentials", () => {
    expect(url("https://user:pass@gw.example")).toMatchObject({
      rejection: { message: expect.stringContaining("embedded credentials") },
    });
  });

  it("refuses a query string or fragment", () => {
    expect(url("https://gw.example?a=1")).toMatchObject({
      rejection: { message: expect.stringContaining("query strings and fragments") },
    });
    expect(url("https://gw.example#frag")).toMatchObject({
      rejection: { message: expect.stringContaining("query strings and fragments") },
    });
  });

  it("refuses something that is not a URL at all", () => {
    expect(url("gateway.example")).toMatchObject({
      rejection: { message: expect.stringContaining("absolute HTTPS URL") },
    });
  });

  it("is absent, not rejected, when no URL was supplied", () => {
    expect(resolveGatewayUrl(opts())).toEqual({});
  });

  it("is idempotent — normalizing an already-normal URL changes nothing", () => {
    const once = resolveGatewayUrl(opts({ gatewayUrl: "https://gw.example/base/" }));
    if (!("url" in once) || !once.url) throw new Error("expected a URL");
    expect(resolveGatewayUrl(opts({ gatewayUrl: once.url }))).toEqual({ url: once.url });
  });
});

describe("gateway identity", () => {
  it("reserves 'unscoped' for lineage whose identity was never proven", () => {
    for (const value of ["unscoped", "UNSCOPED", " Unscoped "]) {
      expect(invalidGatewayId(value), value).toContain("reserved");
    }
    expect(gatewayIdentityRejection(opts({ gatewayId: "unscoped" }))?.code).toBe(
      "gateway_selection/invalid_gateway_id",
    );
  });

  it("refuses an empty or whitespace-only id", () => {
    expect(gatewayIdentityRejection(opts({ gatewayId: "" }))?.code).toBe(
      "gateway_selection/invalid_gateway_id",
    );
    expect(gatewayIdentityRejection(opts({ gatewayId: "   " }))?.code).toBe(
      "gateway_selection/invalid_gateway_id",
    );
  });

  it("accepts a real id, and an absent one when identity is not strict", () => {
    expect(gatewayIdentityRejection(opts({ gatewayId: "gw-prod-1" }))).toBeUndefined();
    expect(gatewayIdentityRejection(opts())).toBeUndefined();
  });

  it("requires an explicit id under --strict-identity", () => {
    expect(gatewayIdentityRejection(opts({ strictIdentity: true }))?.code).toBe(
      "gateway_selection/gateway_id_required",
    );
    expect(gatewayIdentityRejection(opts({ strictIdentity: true, gatewayId: "  " }))?.code).toBe(
      // Whitespace is invalid before it is absent — the more specific complaint wins.
      "gateway_selection/invalid_gateway_id",
    );
    expect(
      gatewayIdentityRejection(opts({ strictIdentity: true, gatewayId: "gw-prod-1" })),
    ).toBeUndefined();
  });

  it("never invents an identity — an undefined id stays undefined", () => {
    expect(invalidGatewayId(undefined)).toBeUndefined();
  });
});
