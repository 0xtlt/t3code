import { describe, expect, it } from "vite-plus/test";

import {
  nextWorkspaceChoice,
  resolveContainerFlag,
  resolveDefaultWorkspaceChoice,
  settingsPatchForWorkspaceDefault,
  workspaceChoiceFor,
  workspaceDefaultFromSettings,
  workspaceSelectionForChoice,
} from "./workspace-choice";

describe("workspace choice mapping", () => {
  it.each([
    ["local", { mode: "local", container: false }],
    ["worktree", { mode: "worktree", container: false }],
    ["container", { mode: "worktree", container: true }],
  ] as const)("round-trips %s through the wire pair", (choice, selection) => {
    expect(workspaceSelectionForChoice(choice)).toEqual(selection);
    expect(workspaceChoiceFor(selection.mode, selection.container)).toBe(choice);
  });

  it("never reports a local container", () => {
    expect(workspaceChoiceFor("local", true)).toBe("local");
  });

  it("cycles and skips Container where the server lacks it", () => {
    expect(nextWorkspaceChoice("local", true)).toBe("worktree");
    expect(nextWorkspaceChoice("worktree", true)).toBe("container");
    expect(nextWorkspaceChoice("container", true)).toBe("local");
    expect(nextWorkspaceChoice("worktree", false)).toBe("local");
  });
});

describe("default workspace choice", () => {
  it("lets a container default outrank the env-mode default", () => {
    expect(
      resolveDefaultWorkspaceChoice({
        envMode: "local",
        defaultContainer: true,
        containerAvailable: true,
      }),
    ).toBe("container");
  });

  it("falls back to the env mode without a Container-capable server", () => {
    expect(
      resolveDefaultWorkspaceChoice({
        envMode: "worktree",
        defaultContainer: true,
        containerAvailable: false,
      }),
    ).toBe("worktree");
  });

  it("keeps the env mode when no container default is set", () => {
    expect(
      resolveDefaultWorkspaceChoice({
        envMode: "local",
        defaultContainer: false,
        containerAvailable: true,
      }),
    ).toBe("local");
  });
});

describe("resolveContainerFlag", () => {
  it("follows the default until the draft picks a workspace", () => {
    expect(
      resolveContainerFlag({
        draftSelection: undefined,
        defaultChoice: "container",
        containerAvailable: true,
      }),
    ).toBe(true);
  });

  it("treats a draft saved before container threads as not a container", () => {
    expect(
      resolveContainerFlag({
        draftSelection: {},
        defaultChoice: "container",
        containerAvailable: true,
      }),
    ).toBe(false);
  });

  it("honors an explicit container draft", () => {
    expect(
      resolveContainerFlag({
        draftSelection: { container: true },
        defaultChoice: "worktree",
        containerAvailable: true,
      }),
    ).toBe(true);
  });

  it("drops a stored container when the server no longer offers it", () => {
    expect(
      resolveContainerFlag({
        draftSelection: { container: true },
        defaultChoice: "container",
        containerAvailable: false,
      }),
    ).toBe(false);
  });
});

describe("default workspace settings", () => {
  it("writes an explicit false so Local or Worktree beats a t3.json container default", () => {
    expect(settingsPatchForWorkspaceDefault("worktree")).toEqual({
      defaultThreadEnvMode: "worktree",
      defaultThreadContainer: false,
    });
    expect(settingsPatchForWorkspaceDefault("container")).toEqual({
      defaultThreadEnvMode: "worktree",
      defaultThreadContainer: true,
    });
  });

  it("clears both settings on inherit", () => {
    expect(settingsPatchForWorkspaceDefault("inherit")).toEqual({
      defaultThreadEnvMode: null,
      defaultThreadContainer: null,
    });
  });

  it.each(["inherit", "local", "worktree", "container"] as const)(
    "reads back what it wrote for %s",
    (choice) => {
      expect(workspaceDefaultFromSettings(settingsPatchForWorkspaceDefault(choice))).toBe(choice);
    },
  );

  it("selects nothing for a pair no choice writes", () => {
    expect(
      workspaceDefaultFromSettings({ defaultThreadEnvMode: null, defaultThreadContainer: false }),
    ).toBeNull();
  });
});
