import {
  ProjectSecretName,
  PROJECT_SECRET_VALUE_MAX_LENGTH,
  type ContainerEnginePreference,
  type ProjectId,
  type ProjectSecretExposure,
  type ProjectSecretScope,
  type ProjectSecretSetInput,
  type ProjectSecretSummary,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const isProjectSecretName = Schema.is(ProjectSecretName);

export const CONTAINER_ENGINE_LABELS: Record<ContainerEnginePreference, string> = {
  auto: "Automatic",
  docker: "Docker",
  podman: "Podman",
};

export const PROJECT_SECRET_EXPOSURE_LABELS: Record<ProjectSecretExposure, string> = {
  env: "Environment variable",
  file: "File",
  both: "Env + file",
};

export const PROJECT_SECRET_NAME_HINT =
  "Use letters, digits, and underscores, not starting with a digit.";

const MEMORY_LIMIT_PATTERN = /^\d+(\.\d+)?[bkmgBKMG]?$/;
const MAX_CPUS = 512;

/** Blank clears the limit (`null`); anything else must parse like `containerRuntime.cpus`. */
export function parseCpuLimitInput(
  text: string,
): { readonly value: number | null } | { readonly error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { value: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_CPUS) {
    return { error: `Enter a number above 0 and up to ${MAX_CPUS}, like 2 or 0.5.` };
  }
  return { value };
}

export function parseMemoryLimitInput(
  text: string,
): { readonly value: string | null } | { readonly error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { value: null };
  if (!MEMORY_LIMIT_PATTERN.test(trimmed)) {
    return { error: 'Use Docker syntax, like "4g" or "512m".' };
  }
  return { value: trimmed };
}

/**
 * `containerRuntime` is merged field by field on the server, so each edit sends
 * only the field it changed and never overwrites a concurrent change to another.
 */
export function containerRuntimePatch(
  patch: Partial<{
    engine: ContainerEnginePreference;
    cpus: number | null;
    memory: string | null;
    forwardEnv: ReadonlyArray<string>;
  }>,
) {
  return { containerRuntime: patch };
}

export function addForwardedEnvName(
  current: ReadonlyArray<string>,
  input: string,
): { readonly names: ReadonlyArray<string> } | { readonly error: string } {
  const name = input.trim();
  if (!isProjectSecretName(name)) return { error: PROJECT_SECRET_NAME_HINT };
  if (current.includes(name)) return { error: `${name} is already forwarded.` };
  return { names: [...current, name] };
}

export function removeForwardedEnvName(
  current: ReadonlyArray<string>,
  name: string,
): ReadonlyArray<string> {
  return current.filter((entry) => entry !== name);
}

export interface ProjectSecretDraft {
  readonly projectId: ProjectId;
  readonly name: string;
  /** Write-only: an empty value on an existing secret keeps the stored one. */
  readonly value: string;
  readonly exposeAs: ProjectSecretExposure;
  readonly scope: ProjectSecretScope;
  readonly existing: boolean;
}

export function buildProjectSecretSetInput(
  draft: ProjectSecretDraft,
): { readonly input: ProjectSecretSetInput } | { readonly error: string } {
  const name = draft.name.trim();
  if (!isProjectSecretName(name)) return { error: PROJECT_SECRET_NAME_HINT };
  if (draft.value.length === 0 && !draft.existing) return { error: "Enter a value." };
  if (draft.value.length > PROJECT_SECRET_VALUE_MAX_LENGTH) {
    return { error: "That value is too long." };
  }
  if (draft.scope.type === "threads" && draft.scope.threadIds.length === 0) {
    return { error: "Pick at least one thread, or apply it to all threads." };
  }
  return {
    input: {
      projectId: draft.projectId,
      name,
      ...(draft.value.length > 0 ? { value: draft.value } : {}),
      exposeAs: draft.exposeAs,
      scope: draft.scope,
    },
  };
}

export function toggleScopeThread(
  scope: ProjectSecretScope,
  threadId: ThreadId,
): ProjectSecretScope {
  const current = scope.type === "threads" ? scope.threadIds : [];
  const threadIds = current.includes(threadId)
    ? current.filter((id) => id !== threadId)
    : [...current, threadId];
  return { type: "threads", threadIds };
}

/** The value is write-only, so the row shows a fixed mask rather than anything derived from it. */
export function describeProjectSecretRow(secret: ProjectSecretSummary): string {
  const scope =
    secret.scope.type === "all"
      ? "All threads"
      : secret.scope.threadIds.length === 1
        ? "1 thread"
        : `${secret.scope.threadIds.length} threads`;
  return `•••••• · ${PROJECT_SECRET_EXPOSURE_LABELS[secret.exposeAs]} · ${scope}`;
}
