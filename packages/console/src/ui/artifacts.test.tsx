// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConsoleApi } from "./api.js";
import { ArtifactsView } from "./views/artifacts.js";

afterEach(cleanup);
const files = [
  { path: "skill/SKILL.md", bytes: 100 },
  { path: "skill/reference/commands.md", bytes: 200 },
  { path: "mcp/server.js", bytes: 300 },
];
function apiWith(inventory = vi.fn().mockResolvedValue({ files })) {
  return {
    artifacts: inventory,
    artifact: vi.fn().mockImplementation(async (_id: string, path: string) => ({
      path,
      content: "generated file",
      bytes: 14,
      truncated: false,
    })),
  } as unknown as ConsoleApi;
}

describe("interface handoff", () => {
  it("retains the interface in file links and updates selection from the route", async () => {
    const api = apiWith();
    const { rerender } = render(
      <ArtifactsView
        api={api}
        bundleId="demo"
        path=""
        query={new URLSearchParams("interface=skill")}
      />,
    );
    const fileList = screen.getByRole("navigation", { name: "Artifact files" });
    const skill = await within(fileList).findByRole("link", { name: /skill\/SKILL.md/ });
    expect(skill.getAttribute("href")).toBe(
      "#/b/demo/artifacts?interface=skill&path=skill%2FSKILL.md",
    );
    expect(within(fileList).queryByText("mcp/server.js")).toBeNull();
    expect(screen.getByText("2 of 2 files")).toBeTruthy();
    rerender(
      <ArtifactsView
        api={api}
        bundleId="demo"
        path=""
        query={new URLSearchParams("interface=mcp")}
      />,
    );
    expect(within(fileList).getByText("mcp/server.js")).toBeTruthy();
    expect(screen.getByText("1 of 1 file")).toBeTruthy();
  });

  it("distinguishes a failed inventory from zero generated files", async () => {
    render(
      <ArtifactsView
        api={apiWith(vi.fn().mockRejectedValue(new Error("Offline")))}
        bundleId="demo"
        path=""
      />,
    );
    expect(await screen.findByText("File list unavailable")).toBeTruthy();
    expect(screen.queryByText("No files generated")).toBeNull();
    expect(screen.queryByText("0 of 0 files")).toBeNull();
  });

  it("separates an empty filter from a missing interface", async () => {
    render(
      <ArtifactsView
        api={apiWith()}
        bundleId="demo"
        path=""
        query={new URLSearchParams("interface=skill")}
      />,
    );
    await screen.findByText("2 of 2 files");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing" } });
    expect(screen.getByText("No matching files")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(screen.getByText("2 of 2 files")).toBeTruthy();
  });

  it("shows terminal setup for Gemini without presenting an empty connector inventory", async () => {
    const api = apiWith();
    render(
      <ArtifactsView
        api={api}
        bundleId="demo"
        path="mcp/server.js"
        query={new URLSearchParams("interface=targets/gemini-enterprise")}
      />,
    );
    expect(screen.getByRole("heading", { name: "Connect to Gemini Enterprise" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Artifact files" })).toBeNull();
    expect(api.artifact).not.toHaveBeenCalled();
    await screen.findByText("2 files");
    expect(screen.queryByText("No files generated")).toBeNull();
  });
});
