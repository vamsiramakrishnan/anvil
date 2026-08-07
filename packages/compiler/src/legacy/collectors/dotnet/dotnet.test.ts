import { describe, expect, it } from "vitest";
import { collectDotnetLegacy } from "./collector.js";

const WCF_CONFIG = `<?xml version="1.0"?>
<configuration>
  <system.serviceModel>
    <bindings>
      <netMsmqBinding>
        <binding name="durableCommands" durable="true" exactlyOnce="true"
          receiveRetryCount="3" maxRetryCycles="2" deadLetterQueue="System" />
      </netMsmqBinding>
    </bindings>
    <services>
      <service name="Legacy.Payments.RefundService">
        <endpoint name="RefundCommands" contract="Legacy.Payments.IRefunds"
          address="net.msmq://localhost/private/refunds"
          binding="netMsmqBinding" bindingConfiguration="durableCommands" />
      </service>
    </services>
  </system.serviceModel>
</configuration>`;

describe(".NET Framework legacy collector", () => {
  it("extracts declared WCF/MSMQ endpoints and binding posture without executing assemblies", () => {
    const result = collectDotnetLegacy([
      { path: "apps/payments/web.config", bytes: WCF_CONFIG },
      { path: "apps/payments/Legacy.Payments.dll", bytes: new Uint8Array([0x4d, 0x5a, 0, 1]) },
    ]);

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      kind: "service_endpoint",
      coordinate: "dotnet:service:Legacy.Payments.RefundService:endpoint:RefundCommands",
      binding: {
        kind: "msmq",
        config: {
          contract: "Legacy.Payments.IRefunds",
          binding: "netMsmqBinding",
          bindingSettings: {
            durable: "true",
            exactlyOnce: "true",
            receiveRetryCount: "3",
          },
        },
      },
    });
    expect(result.evidence.find((item) => item.path.endsWith(".dll"))).toMatchObject({
      role: "opaque_assembly",
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "dotnet/opaque_assembly" }),
    );
  });

  it("reads only explicit Windows service and IIS deployment metadata", () => {
    const result = collectDotnetLegacy([
      {
        path: "inventory/deployments.json",
        bytes: JSON.stringify({
          windowsServices: [
            {
              name: "RefundWorker",
              startType: "Automatic",
              serviceAccountRef: "svc-refund",
              assemblyPath: "C:/apps/RefundWorker.exe",
            },
          ],
          iis: {
            sites: [
              {
                name: "Legacy API",
                bindings: [{ protocol: "https", host: "refund.internal", port: 443 }],
                applications: [
                  { path: "/refund", applicationPool: "RefundPool", physicalPath: "D:/refund" },
                ],
              },
            ],
          },
        }),
      },
    ]);

    expect(result.observations.map((item) => item.coordinate)).toEqual([
      "dotnet:iis:Legacy API:application:/refund",
      "dotnet:windows-service:RefundWorker",
    ]);
    expect(result.observations.every((item) => item.confidence === "declared")).toBe(true);
  });

  it("is deterministic across artifact order", () => {
    const artifacts = [
      { path: "app/web.config", bytes: WCF_CONFIG },
      {
        path: "inventory/windows.json",
        bytes: JSON.stringify({ windowsServices: [{ name: "RefundWorker" }] }),
      },
    ];
    expect(collectDotnetLegacy(artifacts)).toEqual(collectDotnetLegacy([...artifacts].reverse()));
  });

  it("retains conflicting declarations but marks the coordinate ambiguous", () => {
    const changed = WCF_CONFIG.replace(
      "net.msmq://localhost/private/refunds",
      "net.msmq://host/v2",
    );
    const result = collectDotnetLegacy([
      { path: "a/web.config", bytes: WCF_CONFIG },
      { path: "b/web.config", bytes: changed },
    ]);

    expect(result.observations).toHaveLength(2);
    expect(new Set(result.observations.map((item) => item.id)).size).toBe(2);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "dotnet/ambiguous_coordinate", level: "error" }),
    );
  });

  it.each([
    {
      name: "DOCTYPE/entity declarations",
      artifact: {
        path: "bad/web.config",
        bytes: '<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///etc/passwd">]><configuration/>',
      },
      code: "dotnet/forbidden_xml_construct",
    },
    {
      name: "active configuration secrets",
      artifact: {
        path: "bad/app.config",
        bytes:
          '<configuration><appSettings><add key="apiKey" value="live-value"/></appSettings></configuration>',
      },
      code: "dotnet/secret_like_value",
    },
    {
      name: "path traversal",
      artifact: { path: "../web.config", bytes: WCF_CONFIG },
      code: "dotnet/unsafe_artifact_path",
    },
  ])("refuses $name without retaining the value", ({ artifact, code }) => {
    const result = collectDotnetLegacy([artifact]);
    expect(result.observations).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code, level: "error" }));
    expect(JSON.stringify(result)).not.toContain("live-value");
    expect(JSON.stringify(result)).not.toContain("file:///etc/passwd");
  });

  it("refuses duplicate input coordinates and invalid UTF-8 text", () => {
    const result = collectDotnetLegacy([
      { path: "app/web.config", bytes: WCF_CONFIG },
      { path: "app/web.config", bytes: WCF_CONFIG },
      { path: "bad/app.config", bytes: new Uint8Array([0xc3, 0x28]) },
    ]);
    expect(result.evidence).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "dotnet/duplicate_artifact_path",
      "dotnet/non_utf8_artifact",
    ]);
  });

  it("refuses oversized and malformed configuration", () => {
    const result = collectDotnetLegacy([
      { path: "bad/malformed.config", bytes: "<configuration><system.serviceModel>" },
      { path: "bad/oversized.config", bytes: "x".repeat(4 * 1024 * 1024 + 1) },
    ]);
    expect(result.observations).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "dotnet/malformed_xml",
      "dotnet/oversized_artifact",
    ]);
  });
});
