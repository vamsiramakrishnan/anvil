// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BusinessProject } from "@anvil/air";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ConsoleApi } from "./api.js";
import { BusinessProjectsView } from "./views/business.js";

afterEach(cleanup);
it("clears approval after editing and requires a fresh preview before saving", async () => {
  const project = BusinessProject.parse(
    JSON.parse(
      readFileSync(
        resolve(
          process.cwd().endsWith("packages/console")
            ? "../../examples/business/project.json"
            : "examples/business/project.json",
        ),
        "utf8",
      ),
    ),
  );
  project.definition.actions[0]!.state = "approved";
  const digest = "a".repeat(64),
    view = { project, digest, planDigest: digest, public: {}, impact: null };
  const preview = vi.fn(async ({ project: next }: { project: BusinessProject }) => ({
    ...view,
    project: next,
    digest: "b".repeat(64),
  }));
  const save = vi.fn(async () => view);
  const api = {
    businessProjects: vi.fn(async () => ({ enabled: false, projects: [] })),
    businessProject: vi.fn(async () => view),
    businessJobs: vi.fn(async () => []),
    businessExecutions: vi.fn(async () => []),
    previewBusinessProject: preview,
    saveBusinessProject: save,
  } as unknown as ConsoleApi;
  render(<BusinessProjectsView api={api} id={project.definition.id} />);
  const approved = await screen.findByRole("checkbox");
  expect((approved as HTMLInputElement).checked).toBe(true);
  fireEvent.change(screen.getByLabelText("Business outcome"), {
    target: { value: "A newly worded outcome" },
  });
  expect((approved as HTMLInputElement).checked).toBe(false);
  const inputs = screen.getByRole("textbox", { name: "Public inputs" });
  fireEvent.change(inputs, { target: { value: "null" } });
  expect(inputs.getAttribute("aria-invalid")).toBe("true");
  expect(inputs.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
  fireEvent.change(inputs, {
    target: { value: JSON.stringify(project.definition.actions[0]?.input) },
  });
  expect(inputs.getAttribute("aria-invalid")).toBe("false");
  expect(screen.getByRole("textbox", { name: "Public inputs" })).toBe(inputs);
  expect(
    (screen.getByRole("button", { name: "Save revision" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Validate & preview" }));
  await waitFor(() => expect(preview).toHaveBeenCalledOnce());
  expect(preview.mock.calls[0]?.[0].project.definition.actions[0]?.state).toBe("proposed");
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Save revision" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ expectedDigest: digest })),
  );
});
