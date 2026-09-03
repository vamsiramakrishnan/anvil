import { describe, expect, it } from "vitest";
import { fixtureLegacyCapabilityBinding } from "./test-fixtures.js";
import {
  assertWireBindingMatchesLegacyBinding,
  buildQueueWireBinding,
  LegacyBridgeShapeError,
} from "./wire-binding.js";

describe("buildQueueWireBinding", () => {
  it("derives a coherent wire binding tied to the reviewed binding's content hash", () => {
    const binding = fixtureLegacyCapabilityBinding();
    const wireBinding = buildQueueWireBinding(binding);
    expect(wireBinding.protocol).toBe("queue_request_reply");
    expect(wireBinding.legacyBindingContentHash).toBe(binding.contentHash);
    expect(wireBinding.requestDestination).toBe(binding.transport.target);
    expect(wireBinding.timeoutMs).toBe(binding.semantics.timeoutMs);
    expect(() => assertWireBindingMatchesLegacyBinding(wireBinding, binding)).not.toThrow();
  });

  it("refuses a transport that is not a message queue", () => {
    const binding = fixtureLegacyCapabilityBinding();
    const remoteMethod = {
      ...binding,
      transport: {
        kind: "remote_method" as const,
        protocol: "wcf" as const,
        target: "net.tcp://host/Svc",
        interface: "ISvc",
        method: "Do",
        serialization: "data_contract" as const,
      },
    };
    expect(() => buildQueueWireBinding(remoteMethod)).toThrow(LegacyBridgeShapeError);
  });

  it("refuses a binding with no reply strategy", () => {
    const binding = fixtureLegacyCapabilityBinding();
    const noReply = {
      ...binding,
      transport: { ...binding.transport, reply: { mode: "none" as const } },
    };
    expect(() => buildQueueWireBinding(noReply)).toThrow(/no reply strategy/);
  });

  it("refuses a poll_status completion pattern — not a queue reply", () => {
    const binding = fixtureLegacyCapabilityBinding();
    const polled = {
      ...binding,
      transport: { ...binding.transport, reply: { mode: "poll_status" as const } },
    };
    expect(() => buildQueueWireBinding(polled)).toThrow(/polling status/);
  });
});

describe("assertWireBindingMatchesLegacyBinding", () => {
  it("refuses to serve a wire binding addressed to a different binding", () => {
    const binding = fixtureLegacyCapabilityBinding();
    const other = fixtureLegacyCapabilityBinding({ timeoutMs: 999 });
    const wireBinding = buildQueueWireBinding(binding);
    expect(() => assertWireBindingMatchesLegacyBinding(wireBinding, other)).toThrow(
      LegacyBridgeShapeError,
    );
  });
});
