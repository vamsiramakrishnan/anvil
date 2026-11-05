import { describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { CAPABILITY_FEATURES, capabilitiesDocument } from "./capabilities.js";
import { bufferIO } from "./io.js";

describe("anvil capabilities", () => {
  it("lists exactly the features this tree implements", async () => {
    const io = bufferIO();
    const code = await runAnvilCli(["capabilities", "--json"], { io });
    expect(code).toBe(0);
    expect(JSON.parse(io.stdout.join("\n"))).toEqual({
      features: ["connect.disconnect", "manifest.claim", "token.proxy", "vault.firestore"],
    });
  });

  it("prints one feature per line without --json", async () => {
    const io = bufferIO();
    expect(await runAnvilCli(["capabilities"], { io })).toBe(0);
    expect(io.stdout.join("\n")).toBe(
      "connect.disconnect\nmanifest.claim\ntoken.proxy\nvault.firestore",
    );
  });

  it("keeps names unique and sorted", () => {
    expect(capabilitiesDocument(["b", "a", "b"]).features).toEqual(["a", "b"]);
    expect(new Set(CAPABILITY_FEATURES).size).toBe(CAPABILITY_FEATURES.length);
  });
});
