import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Container threads run a thread's provider CLI, terminals, and project scripts
 * inside a per-thread container whose only project mount is the thread's
 * worktree. See docs/internals/container-threads.md.
 */

export const ContainerEngineKind = Schema.Literals(["docker", "podman"]);
export type ContainerEngineKind = typeof ContainerEngineKind.Type;

export const ContainerEnginePreference = Schema.Literals(["auto", "docker", "podman"]);
export type ContainerEnginePreference = typeof ContainerEnginePreference.Type;

/**
 * `open` uses the engine's default bridge network. `restricted` puts the
 * container on an internal network whose only way out is an egress proxy that
 * allows the provider's API hosts plus `allowedHosts`.
 */
export const ContainerNetworkMode = Schema.Literals(["open", "restricted"]);
export type ContainerNetworkMode = typeof ContainerNetworkMode.Type;

const EnvVarName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
  Schema.isMaxLength(128),
);
const MemoryLimit = TrimmedNonEmptyString.check(Schema.isPattern(/^\d+(\.\d+)?[bkmgBKMG]?$/));
const CpuLimit = Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(512));
const HostPattern = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(\*\.)?[A-Za-z0-9.-]+(:\d+)?$/),
  Schema.isMaxLength(253),
);

/**
 * The `container` section of t3.json. Every field is optional: with none set,
 * T3 Code falls back to `.devcontainer/devcontainer.json`, then to its default
 * image.
 */
export const T3ProjectContainerConfig = Schema.Struct({
  image: Schema.optionalKey(
    TrimmedNonEmptyString.annotate({
      description: 'Base image, e.g. "node:24-bookworm". Ignored when `dockerfile` is set.',
    }),
  ),
  dockerfile: Schema.optionalKey(
    TrimmedNonEmptyString.annotate({
      description: "Repository-relative path to a Dockerfile used to build the base image.",
    }),
  ),
  context: Schema.optionalKey(
    TrimmedNonEmptyString.annotate({
      description:
        "Repository-relative build context for `dockerfile`. Defaults to the Dockerfile's directory.",
    }),
  ),
  buildArgs: Schema.optionalKey(
    Schema.Record(EnvVarName, Schema.String).annotate({
      description: "Build arguments passed to the Dockerfile build.",
    }),
  ),
  devcontainer: Schema.optionalKey(
    TrimmedNonEmptyString.annotate({
      description:
        'Repository-relative path to a devcontainer.json to use instead of this section. Defaults to ".devcontainer/devcontainer.json" when this section sets neither `image` nor `dockerfile`.',
    }),
  ),
  setupCommand: Schema.optionalKey(
    TrimmedNonEmptyString.annotate({
      description:
        "Shell command run once inside a new container, from the worktree, before the agent starts (e.g. dependency install).",
    }),
  ),
  env: Schema.optionalKey(
    Schema.Record(EnvVarName, Schema.String).annotate({
      description: "Literal environment variables set in the container. Do not put secrets here.",
    }),
  ),
  forwardEnv: Schema.optionalKey(
    Schema.Array(EnvVarName).annotate({
      description:
        "Names of host environment variables copied into the container. Nothing else from the host environment is forwarded.",
    }),
  ),
  network: Schema.optionalKey(
    ContainerNetworkMode.annotate({
      description:
        '"open" (the default) allows all outbound traffic. "restricted" only allows the provider\'s API hosts and `allowedHosts`, through an egress proxy.',
    }),
  ),
  allowedHosts: Schema.optionalKey(
    Schema.Array(HostPattern).annotate({
      description:
        'Extra hosts reachable with `network: "restricted"`, e.g. "registry.npmjs.org" or "*.github.com".',
    }),
  ),
  cpus: Schema.optionalKey(CpuLimit.annotate({ description: "CPU limit, e.g. 2 or 0.5." })),
  memory: Schema.optionalKey(
    MemoryLimit.annotate({ description: 'Memory limit in Docker syntax, e.g. "4g" or "512m".' }),
  ),
});
export type T3ProjectContainerConfig = typeof T3ProjectContainerConfig.Type;

/** Machine-level container settings, owned by the environment, not the repository. */
export const ContainerRuntimeSettings = Schema.Struct({
  engine: ContainerEnginePreference.pipe(
    Schema.withDecodingDefault(Effect.succeed("auto" as const)),
  ),
  /** Default limits; a repository's t3.json may lower or raise them. */
  cpus: Schema.NullOr(CpuLimit).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  memory: Schema.NullOr(MemoryLimit).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Host env var names forwarded into every container thread on this machine. */
  forwardEnv: Schema.Array(EnvVarName).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type ContainerRuntimeSettings = typeof ContainerRuntimeSettings.Type;

export const ContainerEngineStatus = Schema.Struct({
  available: Schema.Boolean,
  kind: Schema.optional(ContainerEngineKind),
  version: Schema.optional(Schema.String),
  /** Human-readable reason when unavailable, e.g. "Docker is installed but not running". */
  message: Schema.optional(Schema.String),
});
export type ContainerEngineStatus = typeof ContainerEngineStatus.Type;

export const ThreadContainerState = Schema.Literals([
  "absent",
  "preparing",
  "running",
  "stopped",
  "error",
]);
export type ThreadContainerState = typeof ThreadContainerState.Type;

export const ThreadContainerStatus = Schema.Struct({
  threadId: ThreadId,
  state: ThreadContainerState,
  containerName: Schema.optional(Schema.String),
  image: Schema.optional(Schema.String),
  /** Where the definition came from: "t3.json", a devcontainer.json path, or "default". */
  source: Schema.optional(Schema.String),
  network: Schema.optional(ContainerNetworkMode),
  /**
   * The definition or the project's secrets changed while something was
   * running in the container; it is recreated once nothing runs in it, or on
   * rebuild.
   */
  stale: Schema.optional(Schema.Boolean),
  /** Names only, never values, of env vars forwarded from the host. */
  forwardedEnv: Schema.Array(Schema.String),
  message: Schema.optional(Schema.String),
});
export type ThreadContainerStatus = typeof ThreadContainerStatus.Type;

export const ThreadContainerInput = Schema.Struct({ threadId: ThreadId });
export type ThreadContainerInput = typeof ThreadContainerInput.Type;

export class ContainerError extends Schema.TaggedError<ContainerError>()("ContainerError", {
  message: Schema.String,
}) {}
