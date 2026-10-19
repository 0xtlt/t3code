// @effect-diagnostics nodeBuiltinImport:off -- pure path math and hashing on definition data.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import {
  ContainerError,
  type ContainerNetworkMode,
  type ContainerRuntimeSettings,
  type T3ProjectContainerConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { ServerSettingsService } from "../serverSettings.ts";
import { T3ProjectFileLoader } from "../project/T3ProjectFileLoader.ts";
import { parseJsonc } from "./Jsonc.ts";

export const DEFAULT_CONTAINER_IMAGE = "node:24-bookworm";

export type SetupStep =
  | { readonly kind: "shell"; readonly command: string }
  | { readonly kind: "exec"; readonly argv: ReadonlyArray<string> };

export type ContainerBase =
  | { readonly kind: "image"; readonly image: string }
  | {
      readonly kind: "dockerfile";
      readonly dockerfile: string;
      readonly context: string;
      readonly buildArgs: Readonly<Record<string, string>>;
      /** Part of the image key: editing the Dockerfile must rebuild. */
      readonly dockerfileContent: string;
    };

export interface ContainerDefinition {
  /** "t3.json", the devcontainer.json path relative to the worktree, or "default". */
  readonly source: string;
  readonly base: ContainerBase;
  readonly setup: ReadonlyArray<SetupStep>;
  /** Literal, non-secret values. */
  readonly env: Readonly<Record<string, string>>;
  /** Host variable names copied in by name; see `wrapExec`. */
  readonly forwardEnv: ReadonlyArray<string>;
  readonly network: ContainerNetworkMode;
  readonly allowedHosts: ReadonlyArray<string>;
  readonly cpus: number | null;
  readonly memory: string | null;
  /** Settings that were read but cannot be honored; shown in the thread's container status. */
  readonly notes: ReadonlyArray<string>;
}

// Everything that implies a container shape or a lifecycle we do not emulate.
// `customizations` is editor-only and `name` is cosmetic, so neither is reported.
const UNSUPPORTED_DEVCONTAINER_KEYS = [
  "features",
  "dockerComposeFile",
  "service",
  "runServices",
  "initializeCommand",
  "onCreateCommand",
  "updateContentCommand",
  "postStartCommand",
  "postAttachCommand",
  "mounts",
  "runArgs",
  "workspaceMount",
  "workspaceFolder",
  "remoteUser",
  "containerUser",
  "privileged",
  "capAdd",
  "securityOpt",
  "forwardPorts",
  "appPort",
] as const;

export interface DevcontainerInput {
  /** Path relative to the worktree, for the status source label. */
  readonly relativePath: string;
  /** Absolute folder of the file; its relative paths resolve against this. */
  readonly directory: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface ComposeInput {
  readonly worktreePath: string;
  readonly t3: T3ProjectContainerConfig | undefined;
  readonly devcontainer: DevcontainerInput | undefined;
  readonly runtime: Pick<ContainerRuntimeSettings, "cpus" | "memory" | "forwardEnv">;
}

export type ComposeResult =
  | { readonly ok: true; readonly definition: ContainerDefinition }
  | { readonly ok: false; readonly message: string };

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const asStringRecord = (value: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string") out[key] = entry;
    }
  }
  return out;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const isInside = (root: string, candidate: string): boolean => {
  const relative = NodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

function parseSetupCommand(value: unknown): ReadonlyArray<SetupStep> {
  const one = (entry: unknown): SetupStep | undefined => {
    const command = asString(entry);
    if (command !== undefined) return { kind: "shell", command };
    if (
      Array.isArray(entry) &&
      entry.length > 0 &&
      entry.every((part) => typeof part === "string")
    ) {
      return { kind: "exec", argv: entry as ReadonlyArray<string> };
    }
    return undefined;
  };
  const single = one(value);
  if (single !== undefined) return [single];
  const record = asRecord(value);
  if (record === undefined) return [];
  // The spec runs object entries in parallel; sequential is a valid schedule of the same set.
  return Object.values(record).flatMap((entry) => {
    const step = one(entry);
    return step === undefined ? [] : [step];
  });
}

function expandWorkspaceVariables(value: string, worktreePath: string): string {
  return value
    .replaceAll("${localWorkspaceFolderBasename}", NodePath.basename(worktreePath))
    .replaceAll("${containerWorkspaceFolderBasename}", NodePath.basename(worktreePath))
    .replaceAll("${localWorkspaceFolder}", worktreePath)
    .replaceAll("${containerWorkspaceFolder}", worktreePath);
}

/**
 * Merges t3.json and a devcontainer.json into one definition. t3.json wins
 * field by field; its `image`/`dockerfile` beat the devcontainer's base.
 * Build paths must stay inside the worktree: the definition comes from the
 * repository, and a build context pointing at `/` would copy host files into
 * an image the agent can read.
 */
export function composeDefinition(input: ComposeInput): ComposeResult {
  const { worktreePath, t3, devcontainer, runtime } = input;
  const notes: Array<string> = [];
  const dev = devcontainer?.config;

  const resolveBuildPath = (base: string, relative: string, label: string) => {
    const resolved = NodePath.resolve(base, relative);
    return isInside(worktreePath, resolved)
      ? { ok: true as const, path: resolved }
      : { ok: false as const, message: `${label} "${relative}" is outside the worktree.` };
  };

  let base: ContainerBase | undefined;
  let source = "default";

  if (t3?.dockerfile !== undefined) {
    const dockerfile = resolveBuildPath(
      worktreePath,
      t3.dockerfile,
      "t3.json container.dockerfile",
    );
    if (!dockerfile.ok) return dockerfile;
    const context = resolveBuildPath(
      worktreePath,
      t3.context ?? NodePath.dirname(dockerfile.path),
      "t3.json container.context",
    );
    if (!context.ok) return context;
    base = {
      kind: "dockerfile",
      dockerfile: dockerfile.path,
      context: context.path,
      buildArgs: t3.buildArgs ?? {},
      dockerfileContent: "",
    };
    source = "t3.json";
  } else if (t3?.image !== undefined) {
    base = { kind: "image", image: t3.image };
    source = "t3.json";
  } else if (devcontainer !== undefined && dev !== undefined) {
    const build = asRecord(dev["build"]);
    const dockerfileName = asString(build?.["dockerfile"]) ?? asString(dev["dockerFile"]);
    const image = asString(dev["image"]);
    source = devcontainer.relativePath;
    if (dockerfileName !== undefined) {
      const label = `${devcontainer.relativePath} build.dockerfile`;
      const dockerfile = resolveBuildPath(devcontainer.directory, dockerfileName, label);
      if (!dockerfile.ok) return dockerfile;
      const context = resolveBuildPath(
        devcontainer.directory,
        asString(build?.["context"]) ?? asString(dev["context"]) ?? ".",
        `${devcontainer.relativePath} build.context`,
      );
      if (!context.ok) return context;
      base = {
        kind: "dockerfile",
        dockerfile: dockerfile.path,
        context: context.path,
        buildArgs: asStringRecord(build?.["args"]),
        dockerfileContent: "",
      };
    } else if (image !== undefined) {
      base = { kind: "image", image };
    } else {
      notes.push(`${devcontainer.relativePath} sets neither image nor build.dockerfile.`);
    }
  }

  if (base === undefined) {
    base = { kind: "image", image: DEFAULT_CONTAINER_IMAGE };
    if (devcontainer === undefined) source = "default";
  }

  if (devcontainer !== undefined && dev !== undefined) {
    const unsupported = UNSUPPORTED_DEVCONTAINER_KEYS.filter((key) => dev[key] !== undefined);
    if (unsupported.length > 0) {
      notes.push(
        `${devcontainer.relativePath}: ${unsupported.map((key) => `\`${key}\``).join(", ")} ${
          unsupported.length === 1 ? "is" : "are"
        } not supported and ignored.`,
      );
    }
  }

  const devEnv =
    dev === undefined
      ? {}
      : { ...asStringRecord(dev["containerEnv"]), ...asStringRecord(dev["remoteEnv"]) };
  let usesUnsupportedVariable = false;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries({ ...devEnv, ...t3?.env })) {
    if (/\$\{(?!(?:local|container)WorkspaceFolder(?:Basename)?\})/.test(value)) {
      usesUnsupportedVariable = true;
    }
    env[name] = expandWorkspaceVariables(value, worktreePath);
  }
  if (usesUnsupportedVariable) {
    notes.push(
      "Only ${localWorkspaceFolder}, ${containerWorkspaceFolder} and their Basename forms are expanded in environment values.",
    );
  }

  const setup: ReadonlyArray<SetupStep> =
    t3?.setupCommand !== undefined
      ? [{ kind: "shell", command: t3.setupCommand }]
      : parseSetupCommand(dev?.["postCreateCommand"]);

  return {
    ok: true,
    definition: {
      source,
      base,
      setup,
      env,
      forwardEnv: [...new Set([...runtime.forwardEnv, ...(t3?.forwardEnv ?? [])])],
      network: t3?.network ?? "open",
      allowedHosts: t3?.allowedHosts ?? [],
      cpus: t3?.cpus ?? runtime.cpus,
      memory: t3?.memory ?? runtime.memory,
      notes,
    },
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const sha256Hex = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

/**
 * Identifies what a running container was created from. `forwardEnv` and
 * `notes` are left out: neither changes the container, so editing them must
 * not recreate it.
 */
export function hashDefinition(definition: ContainerDefinition): string {
  const { forwardEnv: _forwardEnv, notes: _notes, source: _source, ...rest } = definition;
  return sha256Hex(stableStringify(rest)).slice(0, 16);
}

const DEVCONTAINER_DEFAULT_PATHS = [".devcontainer/devcontainer.json", ".devcontainer.json"];

/** Reads the thread worktree's t3.json and devcontainer.json into a normalized definition. */
export const makeDefinitionResolver = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const loader = yield* T3ProjectFileLoader;
  const settings = yield* ServerSettingsService;

  const readOptional = (filePath: string) =>
    fileSystem.readFileString(filePath).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  const realInside = (root: string, target: string) =>
    Effect.all([fileSystem.realPath(root), fileSystem.realPath(target)]).pipe(
      Effect.map(([realRoot, realTarget]) => isInside(realRoot, realTarget)),
      // A missing path is reported later by the engine build with a clearer message.
      Effect.orElseSucceed(() => true),
    );

  const resolve = Effect.fn("ContainerDefinition.resolve")(function* (worktreePath: string) {
    const t3 = (yield* loader.load(worktreePath)).pipe(
      Option.flatMapNullishOr((file) => file.container),
    );
    const t3Container = Option.getOrUndefined(t3);
    const runtime = yield* settings.getSettings.pipe(
      Effect.map((value) => value.containerRuntime),
      Effect.orElseSucceed(() => ({
        cpus: null,
        memory: null,
        forwardEnv: [] as ReadonlyArray<string>,
      })),
    );

    let devcontainer: DevcontainerInput | undefined;
    const t3SetsBase = t3Container?.image !== undefined || t3Container?.dockerfile !== undefined;
    const candidates =
      t3Container?.devcontainer !== undefined
        ? [t3Container.devcontainer]
        : t3SetsBase
          ? []
          : DEVCONTAINER_DEFAULT_PATHS;
    for (const relativePath of candidates) {
      const filePath = NodePath.resolve(worktreePath, relativePath);
      if (!isInside(worktreePath, filePath)) {
        return yield* new ContainerError({
          message: `t3.json container.devcontainer "${relativePath}" is outside the worktree.`,
        });
      }
      const raw = yield* readOptional(filePath);
      if (Option.isNone(raw)) {
        if (t3Container?.devcontainer !== undefined) {
          return yield* new ContainerError({
            message: `t3.json container.devcontainer points at "${relativePath}", which does not exist in the worktree.`,
          });
        }
        continue;
      }
      const parsed = asRecord(parseJsonc(raw.value));
      if (parsed === undefined) {
        return yield* new ContainerError({
          message: `${relativePath} is not valid JSON with comments.`,
        });
      }
      devcontainer = {
        relativePath,
        directory: NodePath.dirname(filePath),
        config: parsed,
      };
      break;
    }

    const composed = composeDefinition({
      worktreePath,
      t3: t3Container,
      devcontainer,
      runtime,
    });
    if (!composed.ok) return yield* new ContainerError({ message: composed.message });

    const { base } = composed.definition;
    if (base.kind !== "dockerfile") return composed.definition;
    for (const buildPath of [base.dockerfile, base.context]) {
      if (!(yield* realInside(worktreePath, buildPath))) {
        return yield* new ContainerError({
          message: `The Dockerfile build path "${NodePath.relative(worktreePath, buildPath)}" resolves outside the worktree.`,
        });
      }
    }
    const dockerfileContent = yield* fileSystem.readFileString(base.dockerfile).pipe(
      Effect.mapError(
        () =>
          new ContainerError({
            message: `Dockerfile "${NodePath.relative(worktreePath, base.dockerfile)}" could not be read.`,
          }),
      ),
    );
    return {
      ...composed.definition,
      base: { ...base, dockerfileContent },
    } satisfies ContainerDefinition;
  });

  return { resolve };
});
