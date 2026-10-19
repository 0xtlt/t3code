import type { ThreadEnvMode } from "@t3tools/contracts";

/**
 * The wire keeps `container` a boolean beside the `local | worktree` env mode,
 * so the UI's single three-way choice maps onto that pair: a container thread
 * is always a new worktree.
 */
export type WorkspaceChoice = "local" | "worktree" | "container";

export function workspaceChoiceFor(mode: ThreadEnvMode, container: boolean): WorkspaceChoice {
  if (mode === "worktree" && container) return "container";
  return mode;
}

export function workspaceSelectionForChoice(choice: WorkspaceChoice): {
  readonly mode: ThreadEnvMode;
  readonly container: boolean;
} {
  return choice === "container"
    ? { mode: "worktree", container: true }
    : { mode: choice, container: false };
}

/** Tapping the workspace control cycles; Container is skipped on servers without it. */
export function nextWorkspaceChoice(
  current: WorkspaceChoice,
  containerAvailable: boolean,
): WorkspaceChoice {
  if (current === "local") return "worktree";
  if (current === "worktree") return containerAvailable ? "container" : "local";
  return "local";
}

/**
 * `defaultThreadContainer` outranks the env-mode default: a container default
 * means a new worktree, including for a project the env-mode default would have
 * kept in its checkout because it only has a first commit.
 */
export function resolveDefaultWorkspaceChoice(input: {
  readonly envMode: ThreadEnvMode;
  readonly defaultContainer: boolean;
  readonly containerAvailable: boolean;
}): WorkspaceChoice {
  return input.defaultContainer && input.containerAvailable ? "container" : input.envMode;
}

/**
 * A draft that already chose a workspace keeps its own container flag, so a
 * default that changes later cannot flip it. Without a Container-capable
 * server a stored flag is ignored rather than sent.
 */
export function resolveContainerFlag(input: {
  readonly draftSelection: { readonly container?: boolean | undefined } | undefined;
  readonly defaultChoice: WorkspaceChoice;
  readonly containerAvailable: boolean;
}): boolean {
  if (!input.containerAvailable) return false;
  return input.draftSelection === undefined
    ? input.defaultChoice === "container"
    : input.draftSelection.container === true;
}

export function workspaceChoiceLabel(choice: WorkspaceChoice): string {
  switch (choice) {
    case "local":
      return "Local";
    case "worktree":
      return "Worktree";
    case "container":
      return "Container";
  }
}

/** "inherit" clears both settings so the repository's t3.json, then the built-in default, decides. */
export type WorkspaceDefaultChoice = WorkspaceChoice | "inherit";

/**
 * An explicit Local or Worktree also writes `defaultThreadContainer: false`;
 * otherwise a t3.json `container: true` would still win over the user's pick.
 */
export function settingsPatchForWorkspaceDefault(choice: WorkspaceDefaultChoice): {
  readonly defaultThreadEnvMode: ThreadEnvMode | null;
  readonly defaultThreadContainer: boolean | null;
} {
  if (choice === "inherit") return { defaultThreadEnvMode: null, defaultThreadContainer: null };
  const { mode, container } = workspaceSelectionForChoice(choice);
  return { defaultThreadEnvMode: mode, defaultThreadContainer: container };
}

/** Null when the stored pair matches none of the choices, so none shows as selected. */
export function workspaceDefaultFromSettings(input: {
  readonly defaultThreadEnvMode: ThreadEnvMode | null;
  readonly defaultThreadContainer: boolean | null;
}): WorkspaceDefaultChoice | null {
  const { defaultThreadEnvMode: mode, defaultThreadContainer: container } = input;
  if (container === true) return "container";
  if (mode === null) return container === null ? "inherit" : null;
  return mode;
}
