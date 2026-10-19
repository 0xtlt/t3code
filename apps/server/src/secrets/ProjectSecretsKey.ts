/**
 * The master key that encrypts every project's secrets. It lives in the OS
 * keychain when one answers and in a 0600 file next to the data otherwise, so
 * a headless server still works; `storage` says which, and the settings UI
 * shows it.
 */
import type { ProjectSecretsKeyStorage } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no sync random bytes or digest.
import * as NodeCrypto from "node:crypto";

import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

const KEYCHAIN_SERVICE = "T3 Code project secrets";
const SECRET_TOOL_SERVICE = "t3code-project-secrets";
const FILE_KEY_NAME = "project-secrets.key";
const KEY_BYTES = 32;
const KEY_HEX = /^[0-9a-f]{64}$/;
const KEYCHAIN_COMMAND_TIMEOUT = "10 seconds";
/** `security` exit code for "item not found". */
const SECURITY_ITEM_NOT_FOUND = 44;

export class ProjectSecretsKeyError extends Schema.TaggedError<ProjectSecretsKeyError>()(
  "ProjectSecretsKeyError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The project secrets encryption key is unavailable.";
  }
}

export interface LoadedProjectSecretsKey {
  readonly key: Uint8Array;
  readonly storage: ProjectSecretsKeyStorage;
}

export class ProjectSecretsKey extends Context.Service<
  ProjectSecretsKey,
  {
    /** Loads the key on first use, creating it if needed, then serves it from memory. */
    readonly load: Effect.Effect<LoadedProjectSecretsKey, ProjectSecretsKeyError>;
  }
>()("t3/secrets/ProjectSecretsKey") {}

type KeychainRead =
  | { readonly _tag: "found"; readonly key: Uint8Array }
  | { readonly _tag: "missing" }
  | { readonly _tag: "unavailable" };

interface Keychain {
  readonly read: Effect.Effect<KeychainRead>;
  /** True when the command exited cleanly; the caller reads back to confirm. */
  readonly write: (keyHex: string) => Effect.Effect<boolean>;
}

const parseKeyHex = (text: string): Uint8Array | undefined => {
  const hex = text.trim();
  return KEY_HEX.test(hex) ? Uint8Array.from(Buffer.from(hex, "hex")) : undefined;
};

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && NodeCrypto.timingSafeEqual(left, right);

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const runner = yield* ProcessRunner.ProcessRunner;
  const forcedBackend = yield* Config.String("T3CODE_PROJECT_SECRETS_KEY_STORE").pipe(
    Config.withDefault(""),
  );

  // Different T3 homes (a dev worktree next to the real install) must not
  // share one keychain item, or one would hand the other's key out.
  const account = NodeCrypto.createHash("sha256")
    .update(serverConfig.stateDir)
    .digest("hex")
    .slice(0, 16);

  const run = (command: string, args: ReadonlyArray<string>, stdin?: string) =>
    runner
      .run({
        command,
        args,
        timeout: KEYCHAIN_COMMAND_TIMEOUT,
        maxOutputBytes: 4096,
        ...(stdin === undefined ? {} : { stdin }),
      })
      .pipe(Effect.option);

  // Not `-w <key>` on the command line: argv is readable by every local
  // process. `security -i` takes its commands from stdin instead. The add
  // has no `-U`, so a read that failed for a transient reason can never
  // overwrite a key that exists.
  const macKeychain: Keychain = {
    read: run("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      account,
      "-w",
    ]).pipe(
      Effect.map((result): KeychainRead => {
        if (Option.isNone(result)) return { _tag: "unavailable" };
        if (result.value.code === SECURITY_ITEM_NOT_FOUND) return { _tag: "missing" };
        const key = result.value.code === 0 ? parseKeyHex(result.value.stdout) : undefined;
        return key === undefined ? { _tag: "unavailable" } : { _tag: "found", key };
      }),
    ),
    write: (keyHex) =>
      run(
        "security",
        ["-i"],
        `add-generic-password -s "${KEYCHAIN_SERVICE}" -a ${account} -w ${keyHex}\n`,
      ).pipe(Effect.map((result) => Option.isSome(result) && result.value.code === 0)),
  };

  // `secret-tool lookup` exits 1 with no output for a missing item. Anything
  // that also prints to stderr (no DBus session, locked collection) is the
  // keychain being unreachable, which must not look like a missing key.
  const linuxKeychain: Keychain = {
    read: run("secret-tool", ["lookup", "service", SECRET_TOOL_SERVICE, "account", account]).pipe(
      Effect.map((result): KeychainRead => {
        if (Option.isNone(result)) return { _tag: "unavailable" };
        const { code, stdout, stderr } = result.value;
        if (code === 0) {
          const key = parseKeyHex(stdout);
          return key === undefined ? { _tag: "unavailable" } : { _tag: "found", key };
        }
        return code === 1 && stderr.trim() === "" && stdout.trim() === ""
          ? { _tag: "missing" }
          : { _tag: "unavailable" };
      }),
    ),
    write: (keyHex) =>
      run(
        "secret-tool",
        [
          "store",
          `--label=${KEYCHAIN_SERVICE}`,
          "service",
          SECRET_TOOL_SERVICE,
          "account",
          account,
        ],
        keyHex,
      ).pipe(Effect.map((result) => Option.isSome(result) && result.value.code === 0)),
  };

  const keychain =
    forcedBackend === "file"
      ? undefined
      : platform === "darwin"
        ? macKeychain
        : platform === "linux"
          ? linuxKeychain
          : undefined;

  const loadFromKeychain = (backend: Keychain) =>
    Effect.gen(function* () {
      const existing = yield* backend.read;
      if (existing._tag === "found") return Option.some(existing.key);
      if (existing._tag === "unavailable") return Option.none<Uint8Array>();
      const fresh = Uint8Array.from(NodeCrypto.randomBytes(KEY_BYTES));
      if (!(yield* backend.write(Buffer.from(fresh).toString("hex")))) {
        return Option.none<Uint8Array>();
      }
      // Trust the keychain only once it hands the key back: some setups
      // accept writes and still fail reads.
      const stored = yield* backend.read;
      return stored._tag === "found" && sameBytes(stored.key, fresh)
        ? Option.some(stored.key)
        : Option.none<Uint8Array>();
    });

  const loadFromFile = store.getOrCreateRandom(FILE_KEY_NAME, KEY_BYTES).pipe(
    Effect.mapError((cause) => new ProjectSecretsKeyError({ cause })),
    Effect.filterOrFail(
      (key) => key.length === KEY_BYTES,
      (key) =>
        new ProjectSecretsKeyError({
          cause: `Key file holds ${key.length} bytes, expected ${KEY_BYTES}.`,
        }),
    ),
  );

  const loadFresh = Effect.gen(function* () {
    if (keychain !== undefined) {
      const key = yield* loadFromKeychain(keychain);
      if (Option.isSome(key)) {
        return { key: key.value, storage: "keychain" } satisfies LoadedProjectSecretsKey;
      }
      yield* Effect.logWarning(
        "The OS keychain is unavailable; the project secrets key is kept in a file in the secrets directory.",
      );
    }
    return { key: yield* loadFromFile, storage: "file" } satisfies LoadedProjectSecretsKey;
  });

  const cache = yield* Ref.make(Option.none<LoadedProjectSecretsKey>());
  const lock = yield* Semaphore.make(1);
  // Failures are not cached, so a transient error does not stick.
  const load: ProjectSecretsKey["Service"]["load"] = Ref.get(cache).pipe(
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          lock.withPermits(1)(
            Ref.get(cache).pipe(
              Effect.flatMap(
                Option.match({
                  onSome: Effect.succeed,
                  onNone: () =>
                    loadFresh.pipe(Effect.tap((loaded) => Ref.set(cache, Option.some(loaded)))),
                }),
              ),
            ),
          ),
      }),
    ),
    Effect.withSpan("ProjectSecretsKey.load"),
  );

  return ProjectSecretsKey.of({ load });
});

export const layer = Layer.effect(ProjectSecretsKey, make);
