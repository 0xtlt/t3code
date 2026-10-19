import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectSecretsKey from "./ProjectSecretsKey.ts";

interface RecordedCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin: string | undefined;
}

const output = (code: number, stdout = "", stderr = "") =>
  ({
    stdout,
    stderr,
    code,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  }) as ProcessRunner.ProcessRunOutput;

// Stands in for `security` / `secret-tool`: the tests must never reach a real
// keychain. `item` is the keychain's one stored value.
const makeRunner = (
  behavior: (
    call: RecordedCall,
    item: { value: string | undefined },
  ) => ProcessRunner.ProcessRunOutput,
) => {
  const calls: Array<RecordedCall> = [];
  const item: { value: string | undefined } = { value: undefined };
  const layer = Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          const call = { command: input.command, args: input.args, stdin: input.stdin };
          calls.push(call);
          return behavior(call, item);
        }),
    }),
  );
  return { calls, item, layer };
};

const macBehavior = (call: RecordedCall, item: { value: string | undefined }) => {
  if (call.args[0] === "find-generic-password") {
    return item.value === undefined
      ? output(44, "", "could not be found")
      : output(0, `${item.value}\n`);
  }
  const added = /-w (\S+)\n$/.exec(call.stdin ?? "");
  if (call.args[0] === "-i" && added?.[1] !== undefined) {
    item.value = added[1];
    return output(0);
  }
  return output(1);
};

const linuxBehavior = (call: RecordedCall, item: { value: string | undefined }) => {
  if (call.args[0] === "lookup") {
    return item.value === undefined ? output(1) : output(0, item.value);
  }
  if (call.args[0] === "store" && call.stdin !== undefined) {
    item.value = call.stdin;
    return output(0);
  }
  return output(1);
};

const withKey = <A, E>(
  options: {
    readonly platform: NodeJS.Platform;
    readonly runner: ReturnType<typeof makeRunner>;
    readonly env?: Record<string, string>;
    readonly files: Map<string, Uint8Array>;
  },
  body: Effect.Effect<A, E, ProjectSecretsKey.ProjectSecretsKey>,
) =>
  body.pipe(
    Effect.provide(
      ProjectSecretsKey.layer.pipe(
        Layer.provide(Layer.succeed(HostProcess.Platform, options.platform)),
        Layer.provide(options.runner.layer),
        Layer.provide(
          Layer.succeed(
            ServerSecretStore.ServerSecretStore,
            ServerSecretStore.ServerSecretStore.of({
              get: (name) => Effect.succeed(Option.fromNullishOr(options.files.get(name))),
              set: (name, value) => Effect.sync(() => void options.files.set(name, value)),
              create: (name, value) => Effect.sync(() => void options.files.set(name, value)),
              getOrCreateRandom: (name, bytes) =>
                Effect.sync(() => {
                  const existing = options.files.get(name);
                  if (existing !== undefined) return existing;
                  const created = new Uint8Array(bytes).fill(9);
                  options.files.set(name, created);
                  return created;
                }),
              remove: (name) => Effect.sync(() => void options.files.delete(name)),
            }),
          ),
        ),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-secrets-key-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: options.env ?? {} }))),
      ),
    ),
  );

it.effect("T3CODE_PROJECT_SECRETS_KEY_STORE=file never reaches the keychain", () =>
  Effect.gen(function* () {
    const runner = makeRunner(macBehavior);
    const files = new Map<string, Uint8Array>();
    const loaded = yield* withKey(
      {
        platform: "darwin",
        runner,
        files,
        env: { T3CODE_PROJECT_SECRETS_KEY_STORE: "file" },
      },
      ProjectSecretsKey.ProjectSecretsKey.pipe(Effect.flatMap((keys) => keys.load)),
    );
    assert.strictEqual(loaded.storage, "file");
    assert.strictEqual(loaded.key.length, 32);
    assert.strictEqual(runner.calls.length, 0);
    assert.isTrue(files.has("project-secrets.key"));
  }),
);

it.effect("platforms without a keychain use the key file", () =>
  Effect.gen(function* () {
    const runner = makeRunner(macBehavior);
    const loaded = yield* withKey(
      { platform: "win32", runner, files: new Map() },
      ProjectSecretsKey.ProjectSecretsKey.pipe(Effect.flatMap((keys) => keys.load)),
    );
    assert.strictEqual(loaded.storage, "file");
    assert.strictEqual(runner.calls.length, 0);
  }),
);

it.effect("macOS: creates the key through stdin, never argv, and reuses it", () =>
  Effect.gen(function* () {
    const runner = makeRunner(macBehavior);
    const files = new Map<string, Uint8Array>();
    const load = ProjectSecretsKey.ProjectSecretsKey.pipe(Effect.flatMap((keys) => keys.load));
    const first = yield* withKey({ platform: "darwin", runner, files }, load);
    // A fresh service (a server restart) reads the same key back.
    const second = yield* withKey({ platform: "darwin", runner, files }, load);
    assert.strictEqual(first.storage, "keychain");
    assert.deepStrictEqual(Array.from(second.key), Array.from(first.key));
    const keyHex = Buffer.from(first.key).toString("hex");
    assert.strictEqual(runner.item.value, keyHex);
    for (const call of runner.calls) {
      assert.isFalse(call.args.some((arg) => arg.includes(keyHex)));
    }
    assert.isTrue(
      runner.calls.some((call) => call.args[0] === "-i" && call.stdin?.includes(keyHex)),
    );
    assert.isFalse(files.has("project-secrets.key"));
  }),
);

it.effect("macOS: falls back to the key file when the keychain write does not stick", () =>
  Effect.gen(function* () {
    const runner = makeRunner((call, item) =>
      call.args[0] === "find-generic-password" ? output(44) : ((item.value = undefined), output(0)),
    );
    const files = new Map<string, Uint8Array>();
    const loaded = yield* withKey(
      { platform: "darwin", runner, files },
      ProjectSecretsKey.ProjectSecretsKey.pipe(Effect.flatMap((keys) => keys.load)),
    );
    assert.strictEqual(loaded.storage, "file");
    assert.isTrue(files.has("project-secrets.key"));
  }),
);

it.effect("macOS: a keychain that cannot be read is never overwritten", () =>
  Effect.gen(function* () {
    const runner = makeRunner(() => output(36, "", "User interaction is not allowed."));
    const loaded = yield* withKey(
      { platform: "darwin", runner, files: new Map() },
      ProjectSecretsKey.ProjectSecretsKey.pipe(Effect.flatMap((keys) => keys.load)),
    );
    assert.strictEqual(loaded.storage, "file");
    assert.isFalse(runner.calls.some((call) => call.args[0] === "-i"));
  }),
);

it.effect("Linux: stores through secret-tool stdin and reads it back", () =>
  Effect.gen(function* () {
    const runner = makeRunner(linuxBehavior);
    const loaded = yield* withKey(
      { platform: "linux", runner, files: new Map() },
      ProjectSecretsKey.ProjectSecretsKey.pipe(Effect.flatMap((keys) => keys.load)),
    );
    assert.strictEqual(loaded.storage, "keychain");
    const store = runner.calls.find((call) => call.args[0] === "store");
    assert.strictEqual(store?.stdin, Buffer.from(loaded.key).toString("hex"));
    assert.isFalse(store?.args.some((arg) => arg === store.stdin));
  }),
);

it.effect("Linux: no DBus session means the key file, without trying to store", () =>
  Effect.gen(function* () {
    const runner = makeRunner(() => output(1, "", "Cannot autolaunch D-Bus without X11 $DISPLAY"));
    const loaded = yield* withKey(
      { platform: "linux", runner, files: new Map() },
      ProjectSecretsKey.ProjectSecretsKey.pipe(Effect.flatMap((keys) => keys.load)),
    );
    assert.strictEqual(loaded.storage, "file");
    assert.isFalse(runner.calls.some((call) => call.args[0] === "store"));
  }),
);
