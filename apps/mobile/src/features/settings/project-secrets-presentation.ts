import {
  ProjectSecretName,
  type ProjectSecretExposure,
  type ProjectSecretSetInput,
  type ProjectSecretSummary,
  PROJECT_SECRET_VALUE_MAX_LENGTH,
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const PROJECT_SECRET_EXPOSURE_CHOICES: ReadonlyArray<{
  readonly exposeAs: ProjectSecretExposure;
  readonly label: string;
  readonly description: string;
}> = [
  { exposeAs: "env", label: "Environment variable", description: "Set in the container's env." },
  { exposeAs: "file", label: "File", description: "Read-only file at /run/secrets/<NAME>." },
  { exposeAs: "both", label: "Both", description: "Environment variable and file." },
];

const isSecretName = Schema.is(ProjectSecretName);

/** Mobile only creates secrets for every thread; narrower scopes are shown but edited on desktop. */
export function buildProjectSecretInput(draft: {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly value: string;
  readonly exposeAs: ProjectSecretExposure;
}): { readonly input: ProjectSecretSetInput } | { readonly error: string } {
  const name = draft.name.trim();
  if (!isSecretName(name)) {
    return { error: "Use letters, digits, and underscores, not starting with a digit." };
  }
  if (draft.value.length === 0) {
    return { error: "Enter a value." };
  }
  if (draft.value.length > PROJECT_SECRET_VALUE_MAX_LENGTH) {
    return { error: "That value is too long." };
  }
  return {
    input: {
      projectId: draft.projectId,
      name,
      value: draft.value,
      exposeAs: draft.exposeAs,
      scope: { type: "all" },
    },
  };
}

const EXPOSURE_LABELS: Record<ProjectSecretExposure, string> = {
  env: "Env",
  file: "File",
  both: "Env + file",
};

/** The value is write-only, so every row shows a fixed mask rather than anything derived from it. */
export function describeProjectSecret(secret: ProjectSecretSummary): string {
  const scope =
    secret.scope.type === "all"
      ? "All threads"
      : secret.scope.threadIds.length === 1
        ? "1 thread"
        : `${secret.scope.threadIds.length} threads`;
  return `•••••••• · ${EXPOSURE_LABELS[secret.exposeAs]} · ${scope}`;
}
