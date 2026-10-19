import type { EnvMode } from "../BranchToolbar.logic";

interface WorkspaceDefaultSettings {
  readonly defaultThreadEnvMode: "local" | "worktree" | null;
  readonly defaultThreadContainer: boolean | null;
}

/**
 * Container is stored beside `defaultThreadEnvMode` as its own flag (see
 * `defaultThreadContainer` in contracts), so the settings row folds the two
 * back into the one Local / Worktree / Container choice users see.
 */
export function resolveWorkspaceDefault(settings: WorkspaceDefaultSettings): EnvMode | null {
  if (settings.defaultThreadContainer === true) return "container";
  return settings.defaultThreadEnvMode;
}

/**
 * Picking Local or Worktree writes an explicit `false` so it also wins over a
 * repository t3.json that turns containers on. Servers without container
 * support never see the flag.
 */
export function workspaceDefaultPatch(
  mode: EnvMode,
  options: { readonly containerSupported: boolean },
):
  | { defaultThreadContainer: true }
  | { defaultThreadEnvMode: "local" | "worktree"; defaultThreadContainer?: false } {
  if (mode === "container") return { defaultThreadContainer: true };
  return options.containerSupported
    ? { defaultThreadEnvMode: mode, defaultThreadContainer: false }
    : { defaultThreadEnvMode: mode };
}

export const WORKSPACE_DEFAULT_RESET_PATCH = {
  defaultThreadEnvMode: null,
  defaultThreadContainer: null,
} as const;
