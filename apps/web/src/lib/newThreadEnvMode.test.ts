import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { describe, expect, it } from "vite-plus/test";

import { resolveNewThreadDraftEnvMode } from "./newThreadEnvMode";

const projectId = ProjectId.make("project-a");

function input(
  overrides: Partial<typeof DEFAULT_SERVER_SETTINGS>,
  extra: { projectHasThreads?: boolean; workspaceRoot?: string; containerSupported?: boolean } = {},
) {
  return {
    projectSettings: resolveProjectSettings(
      { ...DEFAULT_SERVER_SETTINGS, ...overrides },
      projectId,
      null,
      null,
    ),
    workspaceRoot: extra.workspaceRoot ?? "/work/repo",
    newProjectsRoot: "/data/projects/",
    projectHasThreads: extra.projectHasThreads ?? true,
    containerSupported: extra.containerSupported ?? true,
  };
}

describe("resolveNewThreadDraftEnvMode", () => {
  it("starts in a container when the default says so and the environment supports it", () => {
    expect(
      resolveNewThreadDraftEnvMode(
        input({ defaultThreadEnvMode: "local", defaultThreadContainer: true }),
      ),
    ).toBe("container");
  });

  it("falls back to the env-mode default without container support", () => {
    expect(
      resolveNewThreadDraftEnvMode(
        input(
          { defaultThreadEnvMode: "worktree", defaultThreadContainer: true },
          { containerSupported: false },
        ),
      ),
    ).toBe("worktree");
  });

  it("ignores the flag when it is off or unset", () => {
    expect(
      resolveNewThreadDraftEnvMode(
        input({ defaultThreadEnvMode: "worktree", defaultThreadContainer: false }),
      ),
    ).toBe("worktree");
    expect(
      resolveNewThreadDraftEnvMode(
        input({ defaultThreadEnvMode: "local", defaultThreadContainer: null }),
      ),
    ).toBe("local");
  });

  it("still starts a brand-new project folder in its checkout", () => {
    expect(
      resolveNewThreadDraftEnvMode(
        input(
          { defaultThreadEnvMode: "worktree", defaultThreadContainer: true },
          { projectHasThreads: false, workspaceRoot: "/data/projects/pinball-stats" },
        ),
      ),
    ).toBe("local");
  });
});
