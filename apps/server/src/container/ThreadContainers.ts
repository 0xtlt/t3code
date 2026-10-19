import {
  ContainerError,
  ThreadId,
  type ContainerEngineStatus,
  type ProjectId,
  type ThreadContainerStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectSecrets from "../secrets/ProjectSecrets.ts";
import {
  buildBaseImageBuildArgs,
  buildDerivedImageBuildArgs,
  buildExecArgs,
  buildProxyRunArgs,
  buildRunArgs,
  baseLabels,
  containerNames,
  currentHostUser,
  defaultBridgeNetwork,
  environmentHash,
  HOST_ALIAS,
  isHostSpecificEnvName,
  labelArgs,
  LABEL_DEFINITION,
  LABEL_ENVIRONMENT,
  LABEL_ROLE,
  LABEL_SECRETS,
  LABEL_THREAD,
  proxyEnv,
  restrictedAllowedHosts,
  selectForwardedEnv,
  unsafeMountPath,
  type ContainerNames,
} from "./ContainerCommands.ts";
import {
  hashDefinition,
  makeDefinitionResolver,
  sha256Hex,
  type ContainerDefinition,
} from "./ContainerDefinition.ts";
import {
  ContainerEngine,
  layer as ContainerEngineLayer,
  type EngineHandle,
  type EngineRunOptions,
} from "./ContainerEngine.ts";
import {
  baseImageTag,
  ContainerLayerOptions,
  derivedImageTag,
  renderDerivedDockerfile,
} from "./DerivedImage.ts";

/**
 * Owns the per-thread containers of container threads: engine detection, image
 * builds, container lifecycle, and translating a host command into one that
 * runs inside the thread's container. See docs/internals/container-threads.md.
 *
 * The worktree (and the repository's git common dir, which the worktree's
 * `.git` file points at) are bind-mounted at their host paths, so cwd, file
 * paths in tool calls, diffs, and checkpoints need no translation.
 */
export class ThreadContainers extends Context.Service<
  ThreadContainers,
  {
    /** Detects the engine from `containerRuntime.engine`. Never fails; unavailability is a status. */
    readonly engineStatus: Effect.Effect<ContainerEngineStatus>;
    /** True when the thread was created with `container: true`. Unknown threads are false. */
    readonly isContainerThread: (threadId: ThreadId) => Effect.Effect<boolean>;
    /**
     * Builds or reuses the image, then creates or starts the thread's container
     * and, on first creation, runs the definition's setup command. Idempotent
     * and serialized per thread; a running container whose definition hash
     * still matches returns immediately. A changed definition recreates the
     * container (its home volume is kept).
     */
    readonly ensure: (
      threadId: ThreadId,
      options?: {
        /** Image build and setup-command output lines, for the launch's setup stage. */
        readonly onOutput?: ((line: string) => Effect.Effect<void>) | undefined;
      },
    ) => Effect.Effect<ThreadContainerStatus, ContainerError>;
    /**
     * Host argv that runs `command args` inside the thread's container, from
     * the worktree, after `ensure`. `command` may be a host path; only its
     * basename is used inside the container.
     *
     * Env: values never go into argv. A variable is forwarded by name
     * (`-e NAME`, read by the engine CLI from the env the caller spawns it
     * with) when it is in `forwardEnv`, in the configured allowlists, or set
     * in `env` to a value that differs from the server's own environment.
     * Host-specific variables (PATH, HOME, TMPDIR, XDG_*, CODEX_HOME,
     * CLAUDE_CONFIG_DIR, ...) are never forwarded. `setEnv` sets literal,
     * non-secret container values such as `CODEX_HOME=/t3home/.codex`.
     */
    readonly wrapExec: (input: {
      readonly threadId: ThreadId;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env?: NodeJS.ProcessEnv | undefined;
      readonly forwardEnv?: ReadonlyArray<string> | undefined;
      readonly setEnv?: Readonly<Record<string, string>> | undefined;
      /** Allocate a TTY (terminals). Providers talk over plain stdio pipes. */
      readonly tty: boolean;
    }) => Effect.Effect<
      { readonly command: string; readonly args: ReadonlyArray<string> },
      ContainerError
    >;
    /** Copies a host file into the container (after `ensure`), e.g. a provider auth file. */
    readonly copyIn: (input: {
      readonly threadId: ThreadId;
      readonly hostPath: string;
      readonly containerPath: string;
    }) => Effect.Effect<void, ContainerError>;
    /** Hostname that reaches this server from inside a container. */
    readonly hostAddress: string;
    readonly status: (threadId: ThreadId) => Effect.Effect<ThreadContainerStatus>;
    readonly stop: (threadId: ThreadId) => Effect.Effect<ThreadContainerStatus, ContainerError>;
    /** Removes the container and forgets the image for this definition so the next `ensure` rebuilds. */
    readonly rebuild: (threadId: ThreadId) => Effect.Effect<ThreadContainerStatus, ContainerError>;
    /**
     * Removes the container and its network. `purge` also removes the home
     * volume (thread deleted); archive keeps it so an unarchived thread can
     * resume its provider session.
     */
    readonly remove: (
      threadId: ThreadId,
      options: { readonly purge: boolean },
    ) => Effect.Effect<void>;
    /** Startup sweep: removes containers of this environment whose thread is gone or archived. */
    readonly reconcile: Effect.Effect<void>;
  }
>()("t3/container/ThreadContainers") {}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SETUP_TIMEOUT = "30 minutes";
const BUILD_TIMEOUT = "30 minutes";
const FILE_SECRET_TIMEOUT = "30 seconds";

interface ThreadInfo {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string;
  readonly providerInstanceIds: ReadonlyArray<string>;
}

interface KnownContainer {
  readonly worktreePath: string;
  readonly names: ContainerNames;
  readonly forwardEnv: ReadonlyArray<string>;
}

interface InspectedContainer {
  readonly running: boolean;
  readonly labels: Readonly<Record<string, string>>;
  readonly image: string | undefined;
  /** True when a process started with `exec` is still alive, or when that cannot be told. */
  readonly busy: boolean;
}

const containerError = (message: string) => new ContainerError({ message });

export function parseInspect(stdout: string): InspectedContainer | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    if (typeof entry !== "object" || entry === null) return undefined;
    const record = entry as {
      State?: { Running?: unknown };
      Config?: { Labels?: Record<string, unknown> | null; Image?: unknown };
      ExecIDs?: unknown;
    };
    const labels: Record<string, string> = {};
    for (const [key, value] of Object.entries(record.Config?.Labels ?? {})) {
      if (typeof value === "string") labels[key] = value;
    }
    return {
      running: record.State?.Running === true,
      labels,
      image: typeof record.Config?.Image === "string" ? record.Config.Image : undefined,
      // Docker reports null once every exec has ended. A missing key means an
      // engine that does not say, so assume something is running.
      busy:
        record.ExecIDs === undefined
          ? true
          : Array.isArray(record.ExecIDs) && record.ExecIDs.length > 0,
    };
  } catch {
    return undefined;
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* ContainerEngine;
  const definitions = yield* makeDefinitionResolver;
  const projection = yield* ProjectionStore.ProjectionStoreV2;
  const secrets = yield* ProjectSecrets.ProjectSecrets;
  const runner = yield* ProcessRunner.ProcessRunner;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const layerOptions = yield* ContainerLayerOptions;
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const hostEnvironment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;

  const envHash = environmentHash(stateDir);
  const hostUser = currentHostUser(platform);
  const addHostGateway = platform === "linux";

  const locks = new Map<string, Semaphore.Semaphore>();
  const known = new Map<string, KnownContainer>();
  const preparing = new Set<string>();
  const lastError = new Map<string, string>();
  const forceRebuild = new Set<string>();

  const lockFor = (threadId: ThreadId) => {
    let lock = locks.get(threadId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(threadId, lock);
    }
    return lock;
  };

  const loadThread = Effect.fn("ThreadContainers.loadThread")(function* (threadId: ThreadId) {
    const shell = yield* projection
      .getThreadShell(threadId)
      .pipe(Effect.mapError(() => containerError("The thread could not be read.")));
    if (shell === null) return yield* containerError("The thread does not exist.");
    if (shell.container !== true) {
      return yield* containerError("The thread is not a container thread.");
    }
    if (shell.worktreePath === null) {
      return yield* containerError(
        "The thread has no worktree yet, so its container cannot start.",
      );
    }
    const worktreeExists = yield* fileSystem
      .exists(shell.worktreePath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!worktreeExists) {
      return yield* containerError(
        `The thread's worktree ${shell.worktreePath} does not exist on disk.`,
      );
    }
    return {
      threadId,
      projectId: shell.projectId,
      worktreePath: shell.worktreePath,
      providerInstanceIds: [shell.providerInstanceId, ...(shell.providerInstanceHistory ?? [])],
    } satisfies ThreadInfo;
  });

  const inspectContainer = (name: string) =>
    engine
      .run(["inspect", "--type", "container", "--format", "{{json .}}", name])
      .pipe(Effect.map((result) => (result.code === 0 ? parseInspect(result.stdout) : undefined)));

  const checked = (what: string, args: ReadonlyArray<string>, options?: EngineRunOptions) =>
    engine.runChecked(what, args, options).pipe(Effect.asVoid);

  const resolveSecrets = (info: ThreadInfo) =>
    secrets
      .resolveForThread({ projectId: info.projectId, threadId: info.threadId })
      .pipe(Effect.mapError(() => containerError("The project's secrets could not be read.")));

  const redactedLine = (
    threadId: ThreadId,
    onOutput: ((line: string) => Effect.Effect<void>) | undefined,
  ) =>
    onOutput === undefined ? undefined : (line: string) => onOutput(secrets.redact(threadId, line));

  const forwardedNames = (definition: ContainerDefinition, worktreePath: string) =>
    selectForwardedEnv({
      env: hostEnvironment,
      hostEnv: hostEnvironment,
      forwardEnv: definition.forwardEnv,
      homeDirectory,
      worktreePath,
    }).filter((name) => definition.forwardEnv.includes(name));

  const allowedHostsFor = (info: ThreadInfo, definition: ContainerDefinition) =>
    definition.network === "restricted"
      ? restrictedAllowedHosts({
          providerInstanceIds: info.providerInstanceIds,
          allowedHosts: definition.allowedHosts,
        })
      : [];

  const desiredHashFor = (info: ThreadInfo, definition: ContainerDefinition) =>
    sha256Hex(`${hashDefinition(definition)}:${allowedHostsFor(info, definition).join(",")}`).slice(
      0,
      16,
    );

  const statusOf = (
    threadId: ThreadId,
    names: ContainerNames,
    state: ThreadContainerStatus["state"],
    extra: {
      readonly definition?: ContainerDefinition | undefined;
      readonly image?: string | undefined;
      readonly stale?: boolean | undefined;
      readonly message?: string | undefined;
      readonly worktreePath?: string | undefined;
    } = {},
  ): ThreadContainerStatus => {
    const { definition } = extra;
    const message = [...(definition?.notes ?? []), ...(extra.message ? [extra.message] : [])].join(
      " ",
    );
    return {
      threadId,
      state,
      containerName: names.container,
      ...(extra.image === undefined ? {} : { image: extra.image }),
      ...(definition === undefined
        ? {}
        : { source: definition.source, network: definition.network }),
      ...(extra.stale === true ? { stale: true } : {}),
      forwardedEnv:
        definition === undefined || extra.worktreePath === undefined
          ? []
          : forwardedNames(definition, extra.worktreePath),
      ...(message.length > 0 ? { message } : {}),
    };
  };

  const imageExists = (tag: string) =>
    engine
      .run(["image", "inspect", "--format", "{{.Id}}", tag])
      .pipe(Effect.map((result) => result.code === 0));

  const ensureImage = Effect.fn("ThreadContainers.ensureImage")(function* (
    info: ThreadInfo,
    definition: ContainerDefinition,
    handle: EngineHandle,
    onLine: ((line: string) => Effect.Effect<void>) | undefined,
  ) {
    const refresh = forceRebuild.has(info.threadId);
    const tag = derivedImageTag(definition.base, layerOptions);
    if (!refresh && (yield* imageExists(tag))) return tag;

    const { base } = definition;
    let baseImage: string;
    if (base.kind === "image") {
      baseImage = base.image;
    } else {
      baseImage = baseImageTag(base);
      if (refresh || !(yield* imageExists(baseImage))) {
        yield* engine.runChecked(
          "Building the base image failed",
          buildBaseImageBuildArgs({
            kind: handle.kind,
            tag: baseImage,
            dockerfile: base.dockerfile,
            context: base.context,
            buildArgs: base.buildArgs,
            refresh,
          }),
          { onLine, timeout: BUILD_TIMEOUT },
        );
      }
    }
    yield* engine.runChecked(
      "Building the container image failed. The base image needs npm to install the agent CLIs",
      buildDerivedImageBuildArgs({ kind: handle.kind, tag, refresh }),
      {
        onLine,
        timeout: BUILD_TIMEOUT,
        stdin: renderDerivedDockerfile({ baseImage, layer: layerOptions }),
      },
    );
    forceRebuild.delete(info.threadId);
    return tag;
  });

  const gitCommonDir = (worktreePath: string) =>
    runner
      .run({
        command: "git",
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd: worktreePath,
        timeout: "15 seconds",
      })
      .pipe(
        Effect.mapError(() => containerError("git could not be run in the worktree.")),
        Effect.flatMap((result) =>
          result.code === 0 && result.stdout.trim().length > 0
            ? Effect.succeed(result.stdout.trim())
            : Effect.fail(containerError("The worktree is not a git checkout.")),
        ),
      );

  const startProxy = Effect.fn("ThreadContainers.startProxy")(function* (
    info: ThreadInfo,
    definition: ContainerDefinition,
    handle: EngineHandle,
    names: ContainerNames,
  ) {
    const proxy = yield* inspectContainer(names.proxy);
    if (proxy?.running === true) return;
    if (proxy !== undefined) {
      yield* checked("Starting the egress proxy failed", ["start", names.proxy]);
      return;
    }
    const labels = { ...baseLabels(envHash, info.threadId), [LABEL_ROLE]: "proxy" };
    const network = yield* engine.run(["network", "inspect", names.network]);
    if (network.code !== 0) {
      yield* checked("Creating the restricted network failed", [
        "network",
        "create",
        "--internal",
        ...labelArgs(labels),
        names.network,
      ]);
    }
    yield* checked(
      "Starting the egress proxy failed",
      buildProxyRunArgs({
        names,
        labels,
        bridge: defaultBridgeNetwork(handle.kind),
        allowedHosts: allowedHostsFor(info, definition),
        addHostGateway,
      }),
    );
    // Attached second so the proxy has a route out before the agent can use it.
    yield* checked("Attaching the egress proxy failed", [
      "network",
      "connect",
      names.network,
      names.proxy,
    ]);
  });

  const execArgs = (
    names: ContainerNames,
    worktreePath: string,
    command: string,
    args: ReadonlyArray<string>,
    options: { readonly forward?: ReadonlyArray<string>; readonly user?: string } = {},
  ) =>
    buildExecArgs({
      container: names.container,
      worktreePath,
      command,
      args,
      tty: false,
      forwardedNames: options.forward ?? [],
      setEnv: {},
      user: options.user,
    });

  const writeFileSecrets = Effect.fn("ThreadContainers.writeFileSecrets")(function* (
    names: ContainerNames,
    worktreePath: string,
    resolved: ReadonlyArray<ProjectSecrets.ResolvedProjectSecret>,
  ) {
    for (const secret of resolved) {
      if (secret.exposeAs === "env" || !ENV_NAME.test(secret.name)) continue;
      yield* checked(
        `Writing the secret ${secret.name} failed`,
        execArgs(
          names,
          worktreePath,
          "sh",
          [
            "-c",
            'umask 022; cat > /run/secrets/"$1"; chmod 0444 /run/secrets/"$1"',
            "sh",
            secret.name,
          ],
          { user: "0" },
        ),
        { stdin: secret.value, timeout: FILE_SECRET_TIMEOUT },
      );
    }
  });

  const runSetup = Effect.fn("ThreadContainers.runSetup")(function* (
    info: ThreadInfo,
    definition: ContainerDefinition,
    names: ContainerNames,
    onLine: ((line: string) => Effect.Effect<void>) | undefined,
  ) {
    const forward = forwardedNames(definition, info.worktreePath);
    for (const step of definition.setup) {
      const [command, ...args] = step.kind === "shell" ? ["sh", "-c", step.command] : step.argv;
      yield* checked(
        "The container setup command failed",
        execArgs(names, info.worktreePath, command ?? "sh", args, { forward }),
        { onLine, timeout: SETUP_TIMEOUT },
      );
    }
  });

  const removeNamed = (names: ContainerNames, options: { readonly purge: boolean }) =>
    Effect.gen(function* () {
      for (const name of [names.container, names.proxy]) {
        const inspected = yield* inspectContainer(name);
        if (inspected?.labels[LABEL_ENVIRONMENT] === envHash) {
          yield* engine.run(["rm", "-f", name]);
        }
      }
      yield* engine.run(["network", "rm", names.network]);
      if (options.purge) yield* engine.run(["volume", "rm", "-f", names.volume]);
    });

  const createContainer = Effect.fn("ThreadContainers.createContainer")(function* (
    info: ThreadInfo,
    definition: ContainerDefinition,
    handle: EngineHandle,
    names: ContainerNames,
    labels: Readonly<Record<string, string>>,
    resolved: ReadonlyArray<ProjectSecrets.ResolvedProjectSecret>,
    onOutput: ((line: string) => Effect.Effect<void>) | undefined,
  ) {
    const onLine = redactedLine(info.threadId, onOutput);
    const image = yield* ensureImage(info, definition, handle, onLine);

    const commonDir = yield* gitCommonDir(info.worktreePath);
    for (const mountPath of [info.worktreePath, commonDir]) {
      if (unsafeMountPath(mountPath)) {
        return yield* containerError(
          "Container threads need a worktree path that is absolute and has no commas or quotes.",
        );
      }
    }

    const restricted = definition.network === "restricted";
    if (restricted) yield* startProxy(info, definition, handle, names);

    yield* checked("Creating the home volume failed", [
      "volume",
      "create",
      ...labelArgs({ ...baseLabels(envHash, info.threadId), [LABEL_ROLE]: "home" }),
      names.volume,
    ]);

    const secretEnv = resolved.filter(
      (secret) =>
        secret.exposeAs !== "file" &&
        ENV_NAME.test(secret.name) &&
        !isHostSpecificEnvName(secret.name),
    );
    const args = buildRunArgs({
      names,
      image,
      labels,
      worktreePath: info.worktreePath,
      gitCommonDir: commonDir,
      user: hostUser,
      addHostGateway: addHostGateway && !restricted,
      cpus: definition.cpus,
      memory: definition.memory,
      network: restricted ? names.network : undefined,
      env: { ...definition.env, ...(restricted ? proxyEnv(names.proxy) : {}) },
      secretEnvNames: secretEnv.map((secret) => secret.name),
    });
    yield* checked("Starting the container failed", args, {
      env: Object.fromEntries(secretEnv.map((secret) => [secret.name, secret.value])),
    });

    // From here the container exists; remove it on failure so the next
    // `ensure` starts clean instead of trusting a half-prepared one.
    yield* Effect.gen(function* () {
      if (hostUser !== undefined) {
        // Tools call os.userInfo(), which throws for a uid with no passwd entry.
        yield* checked(
          "Preparing the container user failed",
          execArgs(
            names,
            info.worktreePath,
            "sh",
            [
              "-c",
              'grep -q "^[^:]*:[^:]*:$2:" /etc/group || echo "t3code:x:$2:" >> /etc/group; ' +
                'grep -q "^[^:]*:[^:]*:$1:" /etc/passwd || echo "t3code:x:$1:$2::/t3home:/bin/sh" >> /etc/passwd',
              "sh",
              String(hostUser.uid),
              String(hostUser.gid),
            ],
            { user: "0" },
          ),
        );
      }
      yield* writeFileSecrets(names, info.worktreePath, resolved);
      yield* runSetup(info, definition, names, onLine);
    }).pipe(Effect.tapError(() => engine.run(["rm", "-f", names.container]).pipe(Effect.ignore)));
    return image;
  });

  const ensureLocked = Effect.fn("ThreadContainers.ensureLocked")(function* (
    threadId: ThreadId,
    onOutput: ((line: string) => Effect.Effect<void>) | undefined,
  ) {
    const info = yield* loadThread(threadId);
    const handle = yield* engine.require;
    const names = containerNames(envHash, threadId);
    const definition = yield* definitions.resolve(info.worktreePath);
    const { secrets: resolved, fingerprint } = yield* resolveSecrets(info);
    const labels = {
      ...baseLabels(envHash, threadId),
      [LABEL_DEFINITION]: desiredHashFor(info, definition),
      [LABEL_SECRETS]: fingerprint,
    };
    known.set(threadId, {
      worktreePath: info.worktreePath,
      names,
      forwardEnv: definition.forwardEnv,
    });

    const existing = yield* inspectContainer(names.container);
    const matches =
      existing !== undefined &&
      existing.labels[LABEL_ENVIRONMENT] === envHash &&
      existing.labels[LABEL_DEFINITION] === labels[LABEL_DEFINITION] &&
      existing.labels[LABEL_SECRETS] === fingerprint;
    const extra = { definition, worktreePath: info.worktreePath, image: existing?.image };

    if (existing !== undefined && matches) {
      if (existing.running) {
        if (definition.network === "restricted") {
          yield* startProxy(info, definition, handle, names);
        }
        return statusOf(threadId, names, "running", extra);
      }
      if (definition.network === "restricted") {
        yield* startProxy(info, definition, handle, names);
      }
      yield* checked("Starting the container failed", ["start", names.container]);
      // /run/secrets is a tmpfs, so a stopped container comes back without its files.
      yield* writeFileSecrets(names, info.worktreePath, resolved);
      return statusOf(threadId, names, "running", extra);
    }

    if (existing !== undefined) {
      if (existing.running && existing.busy) {
        return statusOf(threadId, names, "running", {
          ...extra,
          stale: true,
          message:
            "The environment definition or project secrets changed. The container is recreated once nothing runs in it.",
        });
      }
      yield* removeNamed(names, { purge: false });
    }

    preparing.add(threadId);
    const image = yield* createContainer(
      info,
      definition,
      handle,
      names,
      labels,
      resolved,
      onOutput,
    ).pipe(Effect.ensuring(Effect.sync(() => preparing.delete(threadId))));
    return statusOf(threadId, names, "running", { ...extra, image });
  });

  const ensure: ThreadContainers["Service"]["ensure"] = (threadId, options) =>
    lockFor(threadId)
      .withPermits(1)(ensureLocked(threadId, options?.onOutput))
      .pipe(
        Effect.tap(() => Effect.sync(() => lastError.delete(threadId))),
        Effect.tapError((error) => Effect.sync(() => lastError.set(threadId, error.message))),
      );

  const isContainerThread: ThreadContainers["Service"]["isContainerThread"] = (threadId) =>
    projection.getThreadShell(threadId).pipe(
      Effect.map((shell) => shell?.container === true),
      Effect.orElseSucceed(() => false),
    );

  const wrapExec: ThreadContainers["Service"]["wrapExec"] = Effect.fn("ThreadContainers.wrapExec")(
    function* (input) {
      yield* ensure(input.threadId);
      const container = known.get(input.threadId);
      if (container === undefined) {
        return yield* containerError("The thread's container is not ready.");
      }
      const handle = yield* engine.require;
      const forward = selectForwardedEnv({
        env: input.env ?? hostEnvironment,
        hostEnv: hostEnvironment,
        forwardEnv: [...(input.forwardEnv ?? []), ...container.forwardEnv],
        homeDirectory,
        worktreePath: container.worktreePath,
      });
      return {
        command: handle.command,
        args: buildExecArgs({
          container: container.names.container,
          worktreePath: container.worktreePath,
          command: input.command,
          args: input.args,
          tty: input.tty,
          forwardedNames: forward,
          setEnv: input.setEnv ?? {},
        }),
      };
    },
  );

  const copyIn: ThreadContainers["Service"]["copyIn"] = Effect.fn("ThreadContainers.copyIn")(
    function* (input) {
      yield* ensure(input.threadId);
      const container = known.get(input.threadId);
      if (container === undefined) {
        return yield* containerError("The thread's container is not ready.");
      }
      const { container: name } = container.names;
      const owner = hostUser === undefined ? undefined : `${hostUser.uid}:${hostUser.gid}`;
      const parent = input.containerPath.replace(/\/[^/]*$/, "") || "/";
      yield* checked(
        "Preparing the destination in the container failed",
        execArgs(
          container.names,
          container.worktreePath,
          "sh",
          [
            "-c",
            'mkdir -p "$1"' + (owner === undefined ? "" : ' && chown "$2" "$1"'),
            "sh",
            parent,
            ...(owner === undefined ? [] : [owner]),
          ],
          { user: "0" },
        ),
      );
      yield* checked("Copying the file into the container failed", [
        "cp",
        input.hostPath,
        `${name}:${input.containerPath}`,
      ]);
      if (owner !== undefined) {
        yield* checked(
          "Fixing ownership of the copied file failed",
          execArgs(
            container.names,
            container.worktreePath,
            "chown",
            ["-R", owner, input.containerPath],
            {
              user: "0",
            },
          ),
        );
      }
    },
  );

  const status: ThreadContainers["Service"]["status"] = (threadId) =>
    Effect.gen(function* () {
      const names = containerNames(envHash, threadId);
      if (preparing.has(threadId)) return statusOf(threadId, names, "preparing");
      const info = yield* loadThread(threadId).pipe(Effect.option);
      if (Option.isNone(info)) {
        return { threadId, state: "absent", forwardedEnv: [] } satisfies ThreadContainerStatus;
      }
      const engineStatus = yield* engine.status;
      if (!engineStatus.available) {
        return {
          threadId,
          state: "error",
          containerName: names.container,
          forwardedEnv: [],
          ...(engineStatus.message === undefined ? {} : { message: engineStatus.message }),
        } satisfies ThreadContainerStatus;
      }
      const definition = yield* definitions.resolve(info.value.worktreePath).pipe(Effect.option);
      const existing = yield* inspectContainer(names.container);
      const base = {
        definition: Option.getOrUndefined(definition),
        worktreePath: info.value.worktreePath,
        image: existing?.image,
      };
      if (existing === undefined) {
        const failure = lastError.get(threadId);
        return failure === undefined
          ? statusOf(threadId, names, "absent", base)
          : statusOf(threadId, names, "error", { ...base, message: failure });
      }
      const fingerprint = yield* resolveSecrets(info.value).pipe(
        Effect.map((value) => value.fingerprint),
        Effect.option,
      );
      const stale =
        Option.isSome(definition) &&
        Option.isSome(fingerprint) &&
        (existing.labels[LABEL_DEFINITION] !== desiredHashFor(info.value, definition.value) ||
          existing.labels[LABEL_SECRETS] !== fingerprint.value);
      return statusOf(threadId, names, existing.running ? "running" : "stopped", {
        ...base,
        stale,
      });
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed<ThreadContainerStatus>({
          threadId,
          state: "error",
          forwardedEnv: [],
          message: "The container status could not be read.",
        }),
      ),
    );

  const stop: ThreadContainers["Service"]["stop"] = (threadId) =>
    lockFor(threadId)
      .withPermits(1)(
        Effect.gen(function* () {
          yield* engine.require;
          const names = containerNames(envHash, threadId);
          for (const name of [names.container, names.proxy]) {
            const inspected = yield* inspectContainer(name);
            if (inspected?.running === true) {
              yield* checked("Stopping the container failed", ["stop", "-t", "10", name]);
            }
          }
        }),
      )
      .pipe(Effect.flatMap(() => status(threadId)));

  const rebuild: ThreadContainers["Service"]["rebuild"] = (threadId) =>
    lockFor(threadId)
      .withPermits(1)(
        Effect.gen(function* () {
          yield* engine.require;
          // Dropping the image may fail while another thread's container uses
          // it, so the flag is what guarantees the next `ensure` rebuilds.
          forceRebuild.add(threadId);
          yield* removeNamed(containerNames(envHash, threadId), { purge: false });
          const info = yield* loadThread(threadId);
          const definition = yield* definitions.resolve(info.worktreePath);
          yield* engine.run(["image", "rm", derivedImageTag(definition.base, layerOptions)]);
        }),
      )
      .pipe(Effect.flatMap(() => status(threadId)));

  const remove: ThreadContainers["Service"]["remove"] = (threadId, options) =>
    lockFor(threadId)
      .withPermits(1)(
        Effect.gen(function* () {
          yield* engine.require;
          yield* removeNamed(containerNames(envHash, threadId), options);
        }),
      )
      .pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            known.delete(threadId);
            lastError.delete(threadId);
            if (options.purge) locks.delete(threadId);
          }),
        ),
        Effect.ignore,
      );

  const labeledThreadIds = (args: ReadonlyArray<string>) =>
    engine.run(args).pipe(
      Effect.map((result) =>
        result.code === 0
          ? result.stdout
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
          : [],
      ),
    );

  const reconcile: ThreadContainers["Service"]["reconcile"] = Effect.gen(function* () {
    yield* engine.require;
    const filter = `label=${LABEL_ENVIRONMENT}=${envHash}`;
    const format = `{{.Label "${LABEL_THREAD}"}}`;
    const withContainers = new Set([
      ...(yield* labeledThreadIds(["ps", "-a", "--filter", filter, "--format", format])),
      ...(yield* labeledThreadIds(["network", "ls", "--filter", filter, "--format", format])),
    ]);
    const withVolumes = yield* labeledThreadIds([
      "volume",
      "ls",
      "--filter",
      filter,
      "--format",
      format,
    ]);
    for (const id of new Set([...withContainers, ...withVolumes])) {
      const threadId = ThreadId.make(id);
      const shell = yield* projection.getThreadShell(threadId);
      if (shell === null) {
        yield* remove(threadId, { purge: true });
      } else if (shell.archivedAt !== null && withContainers.has(id)) {
        yield* remove(threadId, { purge: false });
      }
    }
  }).pipe(Effect.ignoreCause);

  return ThreadContainers.of({
    engineStatus: engine.status,
    isContainerThread,
    ensure,
    wrapExec,
    copyIn,
    hostAddress: HOST_ALIAS,
    status,
    stop,
    rebuild,
    remove,
    reconcile,
  });
});

export const layer = Layer.effect(ThreadContainers, make).pipe(Layer.provide(ContainerEngineLayer));
