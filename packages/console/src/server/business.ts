import {
  type BusinessJobs,
  buildBusinessProject,
  businessProjectView,
  listBusinessProjects,
  readBusinessProject,
  saveBusinessProject,
  validateBusinessProject,
} from "@anvil/harness";
import { invalidRequest } from "./errors.js";
import type { Handlers } from "./http.js";
import type { Request } from "./mutations.js";

/** Thin shared-service handlers; token, origin, size and schema gates remain in the HTTP layer. */
export function businessHandlers(
  root: string,
  jobs: BusinessJobs,
): Pick<
  Handlers,
  | "businessProjects"
  | "businessProject"
  | "saveBusinessProject"
  | "previewBusinessProject"
  | "buildBusinessProject"
  | "businessJobs"
  | "evaluateBusinessProject"
  | "cancelBusinessJob"
> {
  const checked = <T>(work: () => T): T => {
    try {
      return work();
    } catch (e) {
      throw invalidRequest(
        e instanceof Error ? e.message : "Business project operation failed.",
        [],
      );
    }
  };
  return {
    businessProjects: () =>
      checked(() => ({ enabled: jobs.enabled, projects: listBusinessProjects(root) })),
    businessProject: ({ params }) =>
      checked(() => businessProjectView(readBusinessProject(root, params.id ?? ""))),
    saveBusinessProject: ({ body }) =>
      checked(() => {
        const request = body as Request<"saveBusinessProject">;
        const previous = request.expectedDigest
          ? readBusinessProject(root, request.project.definition.id, request.expectedDigest)
          : undefined;
        return businessProjectView(
          saveBusinessProject(root, request.project, request.expectedDigest),
          previous,
        );
      }),
    previewBusinessProject: ({ body }) =>
      checked(() => {
        const request = body as Request<"previewBusinessProject">;
        return businessProjectView(
          validateBusinessProject(request.project),
          request.against
            ? readBusinessProject(root, request.project.definition.id, request.against)
            : undefined,
        );
      }),
    buildBusinessProject: ({ params, body }) =>
      checked(() =>
        buildBusinessProject(
          root,
          params.id ?? "",
          (body as Request<"buildBusinessProject">).expectedDigest,
        ),
      ),
    businessJobs: ({ params }) => checked(() => jobs.list(params.id ?? "")),
    evaluateBusinessProject: ({ params, body }) =>
      checked(() => {
        const request = body as Request<"evaluateBusinessProject">;
        return jobs.submit(params.id ?? "", request.expectedDigest, request.repeats);
      }),
    cancelBusinessJob: ({ params }) =>
      checked(() => jobs.cancel(params.id ?? "", params.jobId ?? "")),
  };
}
