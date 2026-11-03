// @vitest-environment happy-dom
import { IdentityProfile } from "@anvil/air";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConsoleResponse } from "../contract.js";
import { createConsoleApi, type Fetcher } from "./api.js";
import { App } from "./app.js";
import { createMockConsole, mockFetch } from "./dev/mock-server.js";
import { IdentityView } from "./views/identity.js";

const HASH = "a".repeat(64);
const NEXT_HASH = "b".repeat(64);
const profile = IdentityProfile.parse({
  version: 1,
  id: "ultimatix",
  authentication: {
    provider: "oidc",
    issuer: "https://siteminder.example.com",
    audience: "https://ultimatix-mcp.example.com",
    jwksUri: "https://siteminder.example.com/jwks",
  },
  mapping: { tenant: { source: "fixed", value: "tcs" }, upstreamScopes: ["leave.read"] },
  authorization: { adapter: "enterprise", rules: [] },
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function identity(bundleId = "ultimatix"): ConsoleResponse<"identity"> {
  return {
    bundleId,
    bundleHash: HASH,
    configured: false,
    integrity: { state: "missing", findings: [] },
    verifiedLive: false,
    files: [],
  };
}
function preview(bundleId = "ultimatix"): ConsoleResponse<"validateIdentity"> {
  return {
    bundleId,
    bundleHash: HASH,
    ok: true,
    issues: [],
    profile,
    profileDigest: HASH,
    files: ["targets/identity/profile.json"],
  };
}
function harness(
  overrides: { validate?: () => Promise<Response>; apply?: () => Promise<Response> } = {},
) {
  const seen: Array<{ url: string; method: string; body: unknown }> = [];
  let current = identity();
  const fetch: Fetcher = async (url, init) => {
    seen.push({
      url,
      method: String(init.method),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const id = url.split("/")[3] ?? "ultimatix";
    if (init.method === "GET") return json({ ...current, bundleId: id });
    if (url.endsWith("/validate"))
      return overrides.validate ? overrides.validate() : json(preview(id));
    if (overrides.apply) return overrides.apply();
    current = {
      ...current,
      bundleHash: NEXT_HASH,
      configured: true,
      profile,
      profileDigest: HASH,
      integrity: { state: "fresh", findings: [] },
      files: ["targets/identity/profile.json"],
    };
    return json({ written: true, identity: current, warnings: [] });
  };
  return { api: createConsoleApi({ fetch, token: () => "console-token" }), seen };
}
function draft() {
  return screen.getByRole("textbox", { name: "Identity profile JSON" });
}
function applyButton() {
  return screen.getByRole("button", { name: "Apply identity kit" }) as HTMLButtonElement;
}
function enterProfile() {
  fireEvent.change(draft(), { target: { value: JSON.stringify(profile) } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(() => {
  cleanup();
  location.hash = "";
});

describe("identity configuration", () => {
  it("navigates to connector identity independently of Gemini sign-in", async () => {
    const mock = createMockConsole();
    location.hash = "#/b/payments/overview";
    render(<App api={createConsoleApi({ fetch: mockFetch(mock), token: () => mock.token })} />);
    fireEvent.click(await screen.findByRole("link", { name: "Identity" }));
    expect(await screen.findByRole("heading", { name: "Identity", level: 1 })).toBeTruthy();
    expect(
      screen.getByText(/Employees may sign into Gemini Enterprise with Entra ID/),
    ).toBeTruthy();
    expect(screen.getByText("unverified")).toBeTruthy();
    expect(screen.queryByLabelText(/password|access token|client secret/i)).toBeNull();
    expect(screen.queryByRole("link", { name: "Review generated identity files" })).toBeNull();
  });

  it("opens the existing Gemini setup file for an embedded-only profile", async () => {
    const current: ConsoleResponse<"identity"> = {
      ...identity(),
      configured: true,
      profile,
      integrity: { state: "fresh", findings: [] },
      files: ["targets/gemini-enterprise/env.json", "targets/gemini-enterprise/setup.json"],
    };
    const api = createConsoleApi({ fetch: async () => json(current) });
    render(<IdentityView api={api} bundleId="ultimatix" />);
    const link = await screen.findByRole("link", { name: "Review generated identity files" });
    expect(link.getAttribute("href")).toBe(
      "#/b/ultimatix/artifacts?path=targets%2Fgemini-enterprise%2Fsetup.json",
    );
    expect(screen.queryByRole("link", { name: "targets/identity/profile.json" })).toBeNull();
  });

  it.each([
    "stale",
    "invalid",
  ] as const)("shows %s kit paths without artifact links", async (state) => {
    const current: ConsoleResponse<"identity"> = {
      ...identity(),
      configured: true,
      profile,
      integrity: { state, findings: ["Regenerate the identity kit before inspection."] },
      files: ["targets/identity/profile.json", "targets/gemini-enterprise/setup.json"],
    };
    const api = createConsoleApi({ fetch: async () => json(current) });
    render(<IdentityView api={api} bundleId="ultimatix" />);
    await screen.findByText("Regenerate the identity kit before inspection.");
    expect(screen.getByText("targets/identity/profile.json")).toBeTruthy();
    expect(screen.getByText("targets/gemini-enterprise/setup.json")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Review generated identity files" })).toBeNull();
    expect(
      screen
        .getAllByRole("link")
        .every((link) => !link.getAttribute("href")?.includes("/artifacts")),
    ).toBe(true);
  });

  it("requires a server preview of the exact draft and applies its normalized profile and hash", async () => {
    const { api, seen } = harness();
    render(<IdentityView api={api} bundleId="ultimatix" />);
    await screen.findByRole("textbox", { name: "Identity profile JSON" });
    expect(applyButton().disabled).toBe(true);
    enterProfile();
    fireEvent.click(screen.getByRole("button", { name: "Validate profile" }));
    await screen.findByText("valid preview");
    expect(applyButton().disabled).toBe(false);
    fireEvent.change(draft(), { target: { value: `${JSON.stringify(profile)}\n` } });
    expect(applyButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Validate profile" }));
    await screen.findByText("valid preview");
    fireEvent.click(applyButton());
    await screen.findByText(/Identity kit applied/);
    expect(
      seen.find((call) => call.method === "POST" && !call.url.endsWith("/validate"))?.body,
    ).toEqual({ profile, bundleHash: HASH });
    expect(seen.filter((call) => call.url.endsWith("/validate")).map((call) => call.body)).toEqual([
      { profile, bundleHash: HASH },
      { profile, bundleHash: HASH },
    ]);
    expect(await screen.findByText("https://siteminder.example.com")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Review generated identity files" }).getAttribute("href"),
    ).toContain("targets%2Fidentity%2Fprofile.json");
  });

  it("shows binding issues and refuses to apply an invalid profile", async () => {
    const { api, seen } = harness({
      validate: async () =>
        json({
          ...preview(),
          ok: false,
          profile: undefined,
          issues: [{ path: "authorization.rules", message: "Unknown operation leave.delete" }],
        }),
    });
    render(<IdentityView api={api} bundleId="ultimatix" />);
    await screen.findByRole("textbox", { name: "Identity profile JSON" });
    enterProfile();
    fireEvent.click(screen.getByRole("button", { name: "Validate profile" }));
    await screen.findByText(/Unknown operation leave.delete/);
    expect(applyButton().disabled).toBe(true);
    expect(seen.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("ignores validation completing after the draft changes", async () => {
    const request = deferred<Response>();
    const { api } = harness({ validate: () => request.promise });
    render(<IdentityView api={api} bundleId="ultimatix" />);
    await screen.findByRole("textbox", { name: "Identity profile JSON" });
    enterProfile();
    fireEvent.click(screen.getByRole("button", { name: "Validate profile" }));
    fireEvent.change(draft(), { target: { value: "{}" } });
    await act(async () => request.resolve(json(preview())));
    expect(screen.queryByText("valid preview")).toBeNull();
    expect(applyButton().disabled).toBe(true);
  });

  it("clears drafts and pending validation on a bundle switch", async () => {
    const request = deferred<Response>();
    const { api } = harness({ validate: () => request.promise });
    const view = render(<IdentityView api={api} bundleId="ultimatix" />);
    await screen.findByRole("textbox", { name: "Identity profile JSON" });
    enterProfile();
    fireEvent.click(screen.getByRole("button", { name: "Validate profile" }));
    view.rerender(<IdentityView api={api} bundleId="another" />);
    await screen.findByRole("textbox", { name: "Identity profile JSON" });
    await act(async () => request.resolve(json(preview())));
    expect((draft() as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByText("valid preview")).toBeNull();
    expect(applyButton().disabled).toBe(true);
  });

  it("invalidates a preview when apply is refused for stale bundle state", async () => {
    const { api } = harness({
      apply: async () =>
        json(
          {
            error: {
              code: "console/refused",
              message: "Bundle changed; refresh and validate again.",
            },
          },
          409,
        ),
    });
    render(<IdentityView api={api} bundleId="ultimatix" />);
    await screen.findByRole("textbox", { name: "Identity profile JSON" });
    enterProfile();
    fireEvent.click(screen.getByRole("button", { name: "Validate profile" }));
    await screen.findByText("valid preview");
    fireEvent.click(applyButton());
    await screen.findByText("Bundle changed; refresh and validate again.");
    expect(applyButton().disabled).toBe(true);
    expect(screen.queryByText("valid preview")).toBeNull();
  });

  it("bounds imports, rejects malformed JSON locally, and discards late file reads", async () => {
    const { api, seen } = harness();
    render(<IdentityView api={api} bundleId="ultimatix" />);
    await screen.findByRole("textbox", { name: "Identity profile JSON" });
    const input = screen.getByLabelText("Import profile JSON");
    fireEvent.change(input, { target: { files: [{ size: 512 * 1024 + 1 }] } });
    await screen.findByText("Profile files must be no larger than 512 KiB.");
    fireEvent.change(draft(), { target: { value: "not json" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate profile" }));
    await screen.findByText("Enter valid profile JSON, no larger than 512 KiB.");
    expect(seen.every((call) => call.method === "GET")).toBe(true);
    const file = deferred<string>();
    fireEvent.change(input, { target: { files: [{ size: 100, text: () => file.promise }] } });
    fireEvent.change(draft(), { target: { value: "{}" } });
    await act(async () => file.resolve(JSON.stringify(profile)));
    await waitFor(() => expect((draft() as HTMLTextAreaElement).value).toBe("{}"));
  });

  it("imports a profile without applying it and exposes introspection credential references", async () => {
    const introspection = IdentityProfile.parse({
      ...profile,
      authentication: {
        provider: "oauth2_introspection",
        issuer: "https://siteminder.example.com",
        audience: "https://ultimatix-mcp.example.com",
        requiredScopes: ["ultimatix.mcp"],
        introspection: {
          endpoint: "https://siteminder.example.com/introspect",
          clientIdEnv: "SITEMINDER_CLIENT_ID",
          clientSecretEnv: "SITEMINDER_CLIENT_SECRET",
          audienceSource: "dedicated_client",
        },
      },
    });
    const current = {
      ...identity(),
      configured: true,
      profile: introspection,
      profileDigest: HASH,
    };
    const seen: string[] = [];
    const api = createConsoleApi({
      token: () => "token",
      fetch: async (_url, init) => {
        seen.push(String(init.method));
        return json(current);
      },
    });
    render(<IdentityView api={api} bundleId="ultimatix" />);
    await screen.findByText("https://siteminder.example.com/introspect");
    expect(screen.getByText("SITEMINDER_CLIENT_ID, SITEMINDER_CLIENT_SECRET")).toBeTruthy();
    expect(screen.getByText("dedicated_client")).toBeTruthy();
    const value = JSON.stringify({ ...introspection, id: "another-reviewed-profile" });
    fireEvent.change(screen.getByLabelText("Import profile JSON"), {
      target: { files: [{ size: value.length, text: async () => value }] },
    });
    await waitFor(() => expect((draft() as HTMLTextAreaElement).value).toBe(value));
    expect(applyButton().disabled).toBe(true);
    expect(seen).toEqual(["GET"]);
  });
});
