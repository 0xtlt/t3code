import { ThreadId } from "@t3tools/contracts";
import {
  AgentScope,
  type AgentScopeCommand,
  type AgentScopeShape,
} from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ThreadContainers } from "./ThreadContainers.ts";

const CONTAINER_HOME = "/t3home";

// Docker gives `exec -t` no TERM of its own, so a terminal would fall back to a dumb one.
const TERMINAL_FORWARD_ENV = ["TERM", "COLORTERM", "LANG"] as const;

// Prefers bash for the interactive terminal; slim images only have sh.
const TERMINAL_SHELL_ARGS = [
  "-c",
  "command -v bash >/dev/null 2>&1 && exec bash -i || exec sh -i",
] as const;

// Auth and endpoint selection the Claude CLI reads from its environment. The
// subscription login lives in the macOS keychain and cannot cross; users set
// CLAUDE_CODE_OAUTH_TOKEN or an API key instead. Host-path variables
// (CLAUDE_CONFIG_DIR, AWS_PROFILE, GOOGLE_APPLICATION_CREDENTIALS) stay out.
const CLAUDE_AUTH_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
] as const;

// The Agent SDK adds these after T3 hands over the environment, so they are
// named here instead of being found by the "differs from the server" rule.
const CLAUDE_SDK_ENV = [
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
  "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT",
  "CLAUDE_CODE_QUESTION_EXTENDED",
  "CLAUDE_CODE_QUESTION_OPTIONAL_DESCRIPTIONS",
  "TRACEPARENT",
  "TRACESTATE",
] as const;

const CODEX_AUTH_ENV = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
] as const;

const looksLikeHostPath = (value: string | undefined) =>
  value !== undefined && (value.startsWith("/") || value.startsWith("~"));

interface ContainerLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly tty: boolean;
  readonly forwardEnv: ReadonlyArray<string>;
  readonly setEnv: Readonly<Record<string, string>>;
}

/**
 * What a container thread's process needs on top of the host command. The
 * container has its own PATH and HOME, so only names that carry credentials or
 * provider settings cross, never host paths. Unknown names get no launch: a
 * container thread must never fall back to running on the host.
 */
export function containerLaunchFor(input: {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): ContainerLaunch | undefined {
  switch (input.name) {
    case "terminal":
      return {
        command: "/bin/sh",
        args: TERMINAL_SHELL_ARGS,
        tty: true,
        forwardEnv: TERMINAL_FORWARD_ENV,
        setEnv: {},
      };
    case "claude":
      return {
        command: "claude",
        args: input.args,
        tty: false,
        forwardEnv: [...CLAUDE_AUTH_ENV, ...CLAUDE_SDK_ENV],
        setEnv: {},
      };
    case "codex":
      return {
        command: input.command,
        args: input.args,
        tty: false,
        forwardEnv: [
          ...CODEX_AUTH_ENV,
          ...Object.keys(input.env ?? {}).filter(
            (key) =>
              key.startsWith("CODEX_") &&
              key !== "CODEX_HOME" &&
              !looksLikeHostPath(input.env?.[key]),
          ),
        ],
        setEnv: { CODEX_HOME: `${CONTAINER_HOME}/.codex` },
      };
    default:
      return undefined;
  }
}

/** A command that reports `message` on stderr and exits non-zero, in place of a launch that must not happen. */
export function failingCommand(message: string): AgentScopeCommand {
  return {
    command: "/bin/sh",
    args: ["-c", 'printf "%s\\n" "$1" >&2; exit 1', "t3-container", message],
  };
}

const credentialFiles = (
  name: string,
  env: NodeJS.ProcessEnv | undefined,
  home: string,
  path: Path.Path,
) => {
  switch (name) {
    case "claude":
      return {
        hostPath: path.join(
          env?.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"),
          ".credentials.json",
        ),
        containerPath: `${CONTAINER_HOME}/.claude/.credentials.json`,
      };
    case "codex":
      return {
        hostPath: path.join(env?.CODEX_HOME ?? path.join(home, ".codex"), "auth.json"),
        containerPath: `${CONTAINER_HOME}/.codex/auth.json`,
      };
    default:
      return undefined;
  }
};

/**
 * AgentScope sits at the bottom of the server's layer stack, below the provider
 * registry that builds adapters, while ThreadContainers needs persistence and
 * settings from far above it. The link breaks that cycle: the scope is built
 * first and `layerBind` fills the link once ThreadContainers exists. Binding
 * happens during server construction, before any transport serves a request.
 */
export class ContainerScopeLink extends Context.Service<
  ContainerScopeLink,
  Deferred.Deferred<ThreadContainers["Service"]>
>()("t3/container/ContainerAgentScope/ContainerScopeLink") {}

export const layerLink = Layer.effect(
  ContainerScopeLink,
  Deferred.make<ThreadContainers["Service"]>(),
);

export const layerBind = Layer.effectDiscard(
  Effect.gen(function* () {
    const link = yield* ContainerScopeLink;
    yield* Deferred.succeed(link, yield* ThreadContainers);
  }),
);

// Generous: it only matters if a launch races server construction.
const LINK_TIMEOUT = "60 seconds";

/**
 * Decorates the live AgentScope: launches of a container thread run inside its
 * container, everything else keeps the base scope. Providers and terminals
 * keep spawning a local process (the engine CLI) and talking stdio to it.
 */
export const make = Effect.gen(function* () {
  const base = yield* AgentScope;
  const link = yield* ContainerScopeLink;
  // Never falls back to the host: an unbound link fails the launch instead.
  const containersReady = Deferred.await(link).pipe(Effect.timeout(LINK_TIMEOUT));
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;

  const isContainerThread = (threadId: string) =>
    containersReady.pipe(
      Effect.flatMap((containers) => containers.isContainerThread(ThreadId.make(threadId))),
    );

  // Refresh tokens rotate, so a file copied over the container's own would
  // revoke the login it already refreshed. Seed once per thread and server run.
  const seeded = new Set<string>();
  const seedCredentials = Effect.fn("ContainerAgentScope.seedCredentials")(function* (
    threadId: string,
    name: string,
    env: NodeJS.ProcessEnv | undefined,
  ) {
    const files = credentialFiles(name, env, home, path);
    const key = `${threadId}\0${name}`;
    if (files === undefined || seeded.has(key)) return;
    const exists = yield* fileSystem.exists(files.hostPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return;
    const containers = yield* containersReady.pipe(Effect.orDie);
    yield* containers.copyIn({ threadId: ThreadId.make(threadId), ...files }).pipe(
      Effect.tap(() => Effect.sync(() => seeded.add(key))),
      Effect.catch((error) =>
        Effect.logWarning("Could not copy provider credentials into the container", {
          threadId,
          name,
          error: error.message,
        }),
      ),
    );
  });

  const wrap: AgentScopeShape["wrap"] = Effect.fn("ContainerAgentScope.wrap")(function* (input) {
    if (input.threadId === undefined) return yield* base.wrap(input);
    const ready = yield* Effect.result(containersReady);
    if (ready._tag === "Failure") {
      return failingCommand("The container runtime is not ready yet. Nothing was started.");
    }
    const containers = ready.success;
    if (!(yield* containers.isContainerThread(ThreadId.make(input.threadId)))) {
      return yield* base.wrap(input);
    }
    const launch = containerLaunchFor(input);
    if (launch === undefined) {
      return failingCommand(
        `${input.name} can't run in a container thread yet. It was not started on the host.`,
      );
    }
    const threadId = ThreadId.make(input.threadId);
    // Providers ensure the container before they open a session; a terminal does not, and
    // `ensure` returns at once for a running container.
    return yield* containers.ensure(threadId).pipe(
      Effect.andThen(seedCredentials(input.threadId, input.name, input.env)),
      Effect.andThen(
        containers.wrapExec({
          threadId,
          command: launch.command,
          args: launch.args,
          env: input.env,
          forwardEnv: launch.forwardEnv,
          setEnv: launch.setEnv,
          tty: launch.tty,
        }),
      ),
      Effect.catch((error) =>
        Effect.succeed(failingCommand(`Container unavailable: ${error.message}`)),
      ),
    );
  });

  return {
    wrap,
    oomKilled: base.oomKilled,
    inContainer: (threadId) => isContainerThread(threadId).pipe(Effect.orElseSucceed(() => false)),
    clear: base.clear,
  } satisfies AgentScopeShape;
});

/** Needs `ContainerScopeLink`; provide the live `AgentScope` underneath it. */
export const layer = Layer.effect(AgentScope, make);
