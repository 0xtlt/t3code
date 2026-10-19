import { describe, expect, it } from "vite-plus/test";

import {
  resolveWorkspaceDefault,
  WORKSPACE_DEFAULT_RESET_PATCH,
  workspaceDefaultPatch,
} from "./workspaceDefault.logic";

describe("resolveWorkspaceDefault", () => {
  it("shows Container whenever the container flag is on", () => {
    expect(
      resolveWorkspaceDefault({ defaultThreadEnvMode: "local", defaultThreadContainer: true }),
    ).toBe("container");
  });

  it("falls back to the env mode when the flag is off or unset", () => {
    expect(
      resolveWorkspaceDefault({ defaultThreadEnvMode: "worktree", defaultThreadContainer: false }),
    ).toBe("worktree");
    expect(
      resolveWorkspaceDefault({ defaultThreadEnvMode: "local", defaultThreadContainer: null }),
    ).toBe("local");
  });
});

describe("workspaceDefaultPatch", () => {
  it("writes the flag alone for Container", () => {
    expect(workspaceDefaultPatch("container", { containerSupported: true })).toEqual({
      defaultThreadContainer: true,
    });
  });

  it("writes an explicit false with Local/Worktree so it beats a t3.json container default", () => {
    expect(workspaceDefaultPatch("worktree", { containerSupported: true })).toEqual({
      defaultThreadEnvMode: "worktree",
      defaultThreadContainer: false,
    });
  });

  it("never sends the flag to servers without container support", () => {
    expect(workspaceDefaultPatch("local", { containerSupported: false })).toEqual({
      defaultThreadEnvMode: "local",
    });
  });

  it("inherits by clearing both keys", () => {
    expect(WORKSPACE_DEFAULT_RESET_PATCH).toEqual({
      defaultThreadEnvMode: null,
      defaultThreadContainer: null,
    });
  });
});
