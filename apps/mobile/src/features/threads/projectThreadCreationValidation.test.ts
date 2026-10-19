import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  ProjectThreadContainerNeedsWorktreeError,
  resolveProjectThreadCreationBranch,
  validateProjectThreadCreation,
} from "./projectThreadCreationValidation";

describe("resolveProjectThreadCreationBranch", () => {
  it("uses the live checkout for an untouched local draft label and recorded branch", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "local",
        selectedBranch: null,
        currentCheckoutBranch: "feature/x",
      }),
    ).toBe("feature/x");
  });

  it("prefers an explicit picker choice over the current checkout", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "local",
        selectedBranch: "main",
        currentCheckoutBranch: "feature/x",
      }),
    ).toBe("main");
  });

  it("stays null when no ref is checked out (detached HEAD, non-repository, status not loaded)", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "local",
        selectedBranch: null,
        currentCheckoutBranch: null,
      }),
    ).toBeNull();
  });

  it("never borrows the current checkout for a worktree draft", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "worktree",
        selectedBranch: null,
        currentCheckoutBranch: "feature/x",
      }),
    ).toBeNull();
  });

  it("keeps the explicit base branch for a worktree draft", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "worktree",
        selectedBranch: "main",
        currentCheckoutBranch: "feature/x",
      }),
    ).toBe("main");
  });
});

describe("validateProjectThreadCreation with a container", () => {
  const base = {
    environmentId: EnvironmentId.make("environment"),
    projectId: ProjectId.make("project"),
    branch: "main",
    initialMessageText: "Run isolated",
  };

  it("rejects a container in the current checkout", () => {
    expect(
      validateProjectThreadCreation({ ...base, environmentMode: "local", container: true }),
    ).toBeInstanceOf(ProjectThreadContainerNeedsWorktreeError);
  });

  it("accepts a container in a new worktree", () => {
    expect(
      validateProjectThreadCreation({ ...base, environmentMode: "worktree", container: true }),
    ).toBeNull();
  });

  it("still asks for a base branch before creating the worktree", () => {
    expect(
      validateProjectThreadCreation({
        ...base,
        branch: null,
        environmentMode: "worktree",
        container: true,
      })?._tag,
    ).toBe("ProjectThreadBaseBranchRequiredError");
  });
});
