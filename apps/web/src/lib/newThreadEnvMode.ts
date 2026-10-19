import { resolveNewThreadEnvMode } from "@t3tools/shared/projectSettings";

import type { EnvMode } from "../components/BranchToolbar.logic";

type NewThreadEnvModeInput = Parameters<typeof resolveNewThreadEnvMode>[0];

/**
 * The env mode a new thread starts in. A container default wins over the
 * local/worktree default when the environment can run containers, and keeps the
 * same new-project-folder rule: a project with only its first commit starts local.
 */
export function resolveNewThreadDraftEnvMode(
  input: NewThreadEnvModeInput & { readonly containerSupported: boolean },
): EnvMode {
  const { containerSupported, ...rest } = input;
  const configured = resolveNewThreadEnvMode(rest);
  if (!containerSupported || rest.projectSettings.settings.defaultThreadContainer !== true) {
    return configured;
  }
  const asWorktree = resolveNewThreadEnvMode({
    ...rest,
    projectSettings: {
      ...rest.projectSettings,
      settings: { ...rest.projectSettings.settings, defaultThreadEnvMode: "worktree" },
    },
  });
  return asWorktree === "local" ? "local" : "container";
}
