import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Per-project secrets injected into the project's container threads. Values
 * go in through `projectSecrets.set` and never come back out over any
 * transport: reads return names and metadata only.
 */

export const PROJECT_SECRET_VALUE_MAX_LENGTH = 64 * 1024;
export const PROJECT_SECRETS_MAX_COUNT = 100;

export const ProjectSecretName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
  Schema.isMaxLength(128),
);
export type ProjectSecretName = typeof ProjectSecretName.Type;

/** `env`: environment variable. `file`: read-only file at /run/secrets/<NAME>. */
export const ProjectSecretExposure = Schema.Literals(["env", "file", "both"]);
export type ProjectSecretExposure = typeof ProjectSecretExposure.Type;

export const ProjectSecretScope = Schema.Union([
  Schema.Struct({ type: Schema.Literal("all") }),
  Schema.Struct({ type: Schema.Literal("threads"), threadIds: Schema.Array(ThreadId) }),
]);
export type ProjectSecretScope = typeof ProjectSecretScope.Type;

export const ProjectSecretSummary = Schema.Struct({
  name: ProjectSecretName,
  exposeAs: ProjectSecretExposure,
  scope: ProjectSecretScope,
  updatedAt: IsoDateTime,
});
export type ProjectSecretSummary = typeof ProjectSecretSummary.Type;

/**
 * Where the encryption key lives. `file` means the OS keychain was not
 * available and the key sits next to the data, protected by file permissions.
 */
export const ProjectSecretsKeyStorage = Schema.Literals(["keychain", "file"]);
export type ProjectSecretsKeyStorage = typeof ProjectSecretsKeyStorage.Type;

export const ProjectSecretsListInput = Schema.Struct({ projectId: ProjectId });
export type ProjectSecretsListInput = typeof ProjectSecretsListInput.Type;

export const ProjectSecretsListResult = Schema.Struct({
  secrets: Schema.Array(ProjectSecretSummary),
  keyStorage: ProjectSecretsKeyStorage,
});
export type ProjectSecretsListResult = typeof ProjectSecretsListResult.Type;

/** Creates or updates a secret. `value` is required on create and optional on update. */
export const ProjectSecretSetInput = Schema.Struct({
  projectId: ProjectId,
  name: ProjectSecretName,
  value: Schema.optional(
    Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(PROJECT_SECRET_VALUE_MAX_LENGTH)),
  ),
  exposeAs: Schema.optional(ProjectSecretExposure),
  scope: Schema.optional(ProjectSecretScope),
});
export type ProjectSecretSetInput = typeof ProjectSecretSetInput.Type;

export const ProjectSecretRemoveInput = Schema.Struct({
  projectId: ProjectId,
  name: ProjectSecretName,
});
export type ProjectSecretRemoveInput = typeof ProjectSecretRemoveInput.Type;

export class ProjectSecretsError extends Schema.TaggedError<ProjectSecretsError>()(
  "ProjectSecretsError",
  { message: Schema.String },
) {}
