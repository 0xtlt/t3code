import {
  ContainerError,
  type ContainerEngineKind,
  type ContainerEnginePreference,
  type ContainerEngineStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ProcessRunner from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";

export interface EngineHandle {
  readonly kind: ContainerEngineKind;
  /** Absolute path of the engine CLI, resolved against the server's PATH. */
  readonly command: string;
}

export interface EngineRunOptions {
  /** Extra variables for the CLI process (secret values for `-e NAME`), never argv. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly stdin?: string | undefined;
  readonly timeout?: Duration.Input | undefined;
  /** Receives stdout and stderr lines as they arrive, e.g. image build progress. */
  readonly onLine?: ((line: string) => Effect.Effect<void>) | undefined;
}

export interface EngineRunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The engine CLI behind the container threads: detection and a typed way to
 * run it. Everything goes through ProcessRunner with an argv array, never a
 * shell string.
 */
export class ContainerEngine extends Context.Service<
  ContainerEngine,
  {
    /** Never fails; unavailability is a status. */
    readonly status: Effect.Effect<ContainerEngineStatus>;
    readonly require: Effect.Effect<EngineHandle, ContainerError>;
    /** Fails only when the CLI cannot run; the caller decides what an exit code means. */
    readonly run: (
      args: ReadonlyArray<string>,
      options?: EngineRunOptions,
    ) => Effect.Effect<EngineRunResult, ContainerError>;
    /** Like `run`, but a non-zero exit fails with `what` and the tail of the output. */
    readonly runChecked: (
      what: string,
      args: ReadonlyArray<string>,
      options?: EngineRunOptions,
    ) => Effect.Effect<EngineRunResult, ContainerError>;
  }
>()("t3/container/ContainerEngine") {}

const ENGINE_NAMES: Record<ContainerEngineKind, string> = { docker: "Docker", podman: "Podman" };

// GUI-launched apps start with a minimal PATH that misses where Docker Desktop,
// OrbStack, and Homebrew put their CLIs and the credential helpers they call.
const EXTRA_PATH_DIRECTORIES = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/Applications/Docker.app/Contents/Resources/bin",
];

const STATUS_CACHE_MS = 10_000;
const FAILURE_CACHE_MS = 3_000;
const OUTPUT_TAIL_LINES = 12;
const OUTPUT_TAIL_CHARS = 1_500;

type Detection =
  | {
      readonly ok: true;
      readonly handle: EngineHandle;
      readonly version: string | undefined;
    }
  | { readonly ok: false; readonly message: string };

export function parseEngineVersion(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const version = (entry: unknown) =>
      typeof entry === "object" && entry !== null && "Version" in entry
        ? String((entry as { Version: unknown }).Version)
        : undefined;
    const record = parsed as { Server?: unknown; Client?: unknown };
    return version(record.Server) ?? version(record.Client);
  } catch {
    return undefined;
  }
}

export function outputTail(text: string): string {
  const lines = text
    .split(/\r?\n|\r/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const tail = lines.slice(-OUTPUT_TAIL_LINES).join("\n");
  return tail.length > OUTPUT_TAIL_CHARS ? tail.slice(-OUTPUT_TAIL_CHARS) : tail;
}

export function splitLines(state: { pending: string }, chunk: string): Array<string> {
  const parts = (state.pending + chunk).split(/\r\n|\n|\r/);
  state.pending = parts.pop() ?? "";
  return parts.filter((line) => line.length > 0);
}

const notInstalledMessage = (preference: ContainerEnginePreference) =>
  preference === "auto"
    ? "No container engine found. Install Docker or Podman and make sure it is on PATH."
    : `${ENGINE_NAMES[preference]} is not installed (the container runtime setting selects it). Install it or change the setting.`;

const notRunningMessage = (kind: ContainerEngineKind) =>
  kind === "docker"
    ? "Docker is installed but not running. Start Docker Desktop, OrbStack, or Colima and try again."
    : "Podman is installed but not responding. Start the Podman machine (`podman machine start`) and try again.";

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const settings = yield* ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const hostEnvironment = yield* HostProcess.Environment;
  const cache = yield* Ref.make<
    { readonly key: string; readonly expiresAt: number; readonly value: Detection } | undefined
  >(undefined);

  const engineEnvironment = (): NodeJS.ProcessEnv => {
    if (platform === "win32") return hostEnvironment;
    const current = hostEnvironment.PATH ?? "";
    const known = new Set(current.split(":"));
    const extras = EXTRA_PATH_DIRECTORIES.filter((directory) => !known.has(directory));
    return { ...hostEnvironment, PATH: [current, ...extras].filter(Boolean).join(":") };
  };

  const resolveCli = (name: string) =>
    resolveCommandPath(name, { env: engineEnvironment() }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.orElseSucceed(() => null),
    );

  const probe = Effect.fn("ContainerEngine.probe")(function* (kind: ContainerEngineKind) {
    const command = yield* resolveCli(kind);
    if (command === null) return { installed: false as const };
    const result = yield* runner
      .run({
        command,
        args: ["version", "--format", "json"],
        env: engineEnvironment(),
        timeout: "15 seconds",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (result._tag === "None" || result.value.timedOut || result.value.code !== 0) {
      return { installed: true as const, running: false as const };
    }
    return {
      installed: true as const,
      running: true as const,
      handle: { kind, command } satisfies EngineHandle,
      version: parseEngineVersion(result.value.stdout),
    };
  });

  const detect = Effect.fn("ContainerEngine.detect")(function* (
    preference: ContainerEnginePreference,
  ) {
    const kinds: ReadonlyArray<ContainerEngineKind> =
      preference === "auto" ? ["docker", "podman"] : [preference];
    let installedButDown: ContainerEngineKind | undefined;
    for (const kind of kinds) {
      const result = yield* probe(kind);
      if (!result.installed) continue;
      if (result.running) {
        return { ok: true, handle: result.handle, version: result.version } satisfies Detection;
      }
      installedButDown ??= kind;
    }
    return {
      ok: false,
      message:
        installedButDown === undefined
          ? notInstalledMessage(preference)
          : notRunningMessage(installedButDown),
    } satisfies Detection;
  });

  const detection = Effect.gen(function* () {
    const preference = yield* settings.getSettings.pipe(
      Effect.map((value) => value.containerRuntime.engine),
      Effect.orElseSucceed((): ContainerEnginePreference => "auto"),
    );
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(cache);
    if (cached !== undefined && cached.key === preference && cached.expiresAt > now) {
      return cached.value;
    }
    const value = yield* detect(preference);
    yield* Ref.set(cache, {
      key: preference,
      expiresAt: now + (value.ok ? STATUS_CACHE_MS : FAILURE_CACHE_MS),
      value,
    });
    return value;
  });

  const status: ContainerEngine["Service"]["status"] = detection.pipe(
    Effect.map((value): ContainerEngineStatus =>
      value.ok
        ? {
            available: true,
            kind: value.handle.kind,
            ...(value.version === undefined ? {} : { version: value.version }),
          }
        : { available: false, message: value.message },
    ),
    // Detection only reads; if it breaks, report that instead of failing the caller.
    Effect.catchCause(() =>
      Effect.succeed<ContainerEngineStatus>({
        available: false,
        message: "The container engine could not be checked.",
      }),
    ),
  );

  const requireEngine: ContainerEngine["Service"]["require"] = detection.pipe(
    Effect.flatMap((value) =>
      value.ok
        ? Effect.succeed(value.handle)
        : Effect.fail(new ContainerError({ message: value.message })),
    ),
    Effect.catchCause(() =>
      Effect.fail(new ContainerError({ message: "The container engine could not be checked." })),
    ),
  );

  const run: ContainerEngine["Service"]["run"] = Effect.fn("ContainerEngine.run")(
    function* (args, options) {
      const engine = yield* requireEngine;
      const env = { ...engineEnvironment(), ...options?.env };
      const onLine = options?.onLine;
      const timeout = options?.timeout;
      const input = {
        env,
        ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(timeout === undefined ? {} : { timeout }),
      };
      const toError = () =>
        new ContainerError({ message: `Failed to run the ${ENGINE_NAMES[engine.kind]} CLI.` });

      if (onLine === undefined) {
        const result = yield* runner
          .run({ command: engine.command, args, ...input })
          .pipe(Effect.mapError(toError));
        return { code: result.code, stdout: result.stdout, stderr: result.stderr };
      }

      // `2>&1` inside a fixed `exec "$@"` script merges stderr (where builds
      // print progress) into the one stream ProcessRunner can tap live.
      // Windows has no sh, so its lines arrive when the process ends.
      const merged = platform !== "win32";
      const lines = yield* Queue.unbounded<string, Cause.Done>();
      const consumer = yield* Stream.fromQueue(lines).pipe(
        Stream.runForEach(onLine),
        Effect.forkChild,
      );
      const decoder = new TextDecoder();
      const state = { pending: "" };
      const emit = (text: string) => {
        for (const line of splitLines(state, text)) Queue.offerUnsafe(lines, line);
      };
      const result = yield* runner
        .run({
          command: merged ? "/bin/sh" : engine.command,
          args: merged ? ["-c", 'exec "$@" 2>&1', "sh", engine.command, ...args] : args,
          ...input,
          onStdoutChunk: (chunk) => emit(decoder.decode(chunk, { stream: true })),
        })
        .pipe(
          Effect.mapError(toError),
          Effect.tap((finished) =>
            Effect.sync(() => {
              emit(`${decoder.decode()}\n`);
              if (!merged) {
                for (const text of [finished.stdout, finished.stderr]) emit(`${text}\n`);
              }
            }),
          ),
          Effect.ensuring(Effect.sync(() => Queue.endUnsafe(lines))),
        );
      yield* Fiber.join(consumer);
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    },
  );

  const runChecked: ContainerEngine["Service"]["runChecked"] = (what, args, options) =>
    run(args, options).pipe(
      Effect.flatMap((result) => {
        if (result.code === 0) return Effect.succeed(result);
        const tail = outputTail(result.stderr.trim().length > 0 ? result.stderr : result.stdout);
        return Effect.fail(
          new ContainerError({ message: tail.length > 0 ? `${what}: ${tail}` : `${what}.` }),
        );
      }),
    );

  return ContainerEngine.of({ status, require: requireEngine, run, runChecked });
});

export const layer = Layer.effect(ContainerEngine, make);
