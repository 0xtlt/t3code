import { assert, it } from "@effect/vitest";
import {
  PROJECT_SECRETS_MAX_COUNT,
  ProjectId,
  ThreadId,
  type ProjectSecretsKeyStorage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectSecrets from "./ProjectSecrets.ts";
import * as ProjectSecretsKey from "./ProjectSecretsKey.ts";

const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const missingProjectId = ProjectId.make("project-missing");
const thread1 = ThreadId.make("thread-1");
const thread2 = ThreadId.make("thread-2");

const withSecrets = <A, E>(
  body: (input: {
    readonly secrets: ProjectSecrets.ProjectSecrets["Service"];
    readonly files: Map<string, Uint8Array>;
    readonly keyLoads: { count: number };
  }) => Effect.Effect<A, E>,
  options: { readonly key?: Uint8Array; readonly storage?: ProjectSecretsKeyStorage } = {},
) =>
  Effect.gen(function* () {
    const files = new Map<string, Uint8Array>();
    const keyLoads = { count: 0 };
    const key = options.key ?? new Uint8Array(32).fill(3);
    const dependencies = Layer.mergeAll(
      Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: (name) => Effect.succeed(Option.fromNullishOr(files.get(name))),
          set: (name, value) => Effect.sync(() => void files.set(name, value)),
          create: (name, value) => Effect.sync(() => void files.set(name, value)),
          getOrCreateRandom: () => Effect.die("unused"),
          remove: (name) => Effect.sync(() => void files.delete(name)),
        }),
      ),
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: (id) =>
          Effect.succeed(
            id === projectId || id === otherProjectId ? Option.some({} as never) : Option.none(),
          ),
      }),
      Layer.succeed(
        ProjectSecretsKey.ProjectSecretsKey,
        ProjectSecretsKey.ProjectSecretsKey.of({
          load: Effect.sync(() => {
            keyLoads.count += 1;
            return { key, storage: options.storage ?? "keychain" };
          }),
        }),
      ),
    );
    return yield* Effect.gen(function* () {
      const secrets = yield* ProjectSecrets.ProjectSecrets;
      return yield* body({ secrets, files, keyLoads });
    }).pipe(Effect.provide(ProjectSecrets.layer.pipe(Layer.provide(dependencies))));
  });

const VALUE = "ghp_super-secret-token-123";

it.effect("encrypts at rest and never lists values", () =>
  withSecrets(({ secrets, files }) =>
    Effect.gen(function* () {
      yield* secrets.set({ projectId, name: "GH_TOKEN", value: VALUE });
      const blob = Buffer.concat(Array.from(files.values()));
      assert.isFalse(blob.includes(Buffer.from(VALUE)));
      assert.isFalse(blob.includes(Buffer.from("GH_TOKEN")));

      const listed = yield* secrets.list(projectId);
      assert.strictEqual(listed.keyStorage, "keychain");
      assert.deepStrictEqual(
        listed.secrets.map((secret) => [secret.name, secret.exposeAs, secret.scope]),
        [["GH_TOKEN", "env", { type: "all" }]],
      );
      assert.isFalse(JSON.stringify(listed).includes(VALUE));

      const resolved = yield* secrets.resolveForThread({ projectId, threadId: thread1 });
      assert.deepStrictEqual(resolved.secrets, [
        { name: "GH_TOKEN", value: VALUE, exposeAs: "env" },
      ]);
    }),
  ),
);

it.effect("set returns a summary without the value", () =>
  withSecrets(({ secrets }) =>
    Effect.gen(function* () {
      const summary = yield* secrets.set({
        projectId,
        name: "GH_TOKEN",
        value: VALUE,
        exposeAs: "both",
      });
      assert.isFalse(JSON.stringify(summary).includes(VALUE));
      assert.strictEqual(summary.exposeAs, "both");
    }),
  ),
);

it.effect("rejects tampered ciphertext, and remove still recovers the project", () =>
  withSecrets(({ secrets, files }) =>
    Effect.gen(function* () {
      yield* secrets.set({ projectId, name: "GH_TOKEN", value: VALUE });
      const [name, blob] = Array.from(files.entries())[0]!;
      const tampered = Uint8Array.from(blob);
      tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
      files.set(name, tampered);

      const failure = yield* secrets.list(projectId).pipe(Effect.flip);
      assert.include(failure.message, "can't be decrypted");
      assert.isTrue(
        (yield* secrets.set({ projectId, name: "OTHER", value: "abcd" }).pipe(Effect.flip))._tag ===
          "ProjectSecretsError",
      );

      yield* secrets.remove({ projectId, name: "GH_TOKEN" });
      assert.deepStrictEqual((yield* secrets.list(projectId)).secrets, []);
    }),
  ),
);

it.effect("a blob copied onto another project does not decrypt there", () =>
  withSecrets(({ secrets, files }) =>
    Effect.gen(function* () {
      yield* secrets.set({ projectId, name: "GH_TOKEN", value: VALUE });
      const blob = Array.from(files.values())[0]!;
      yield* secrets.set({ projectId: otherProjectId, name: "PLACEHOLDER", value: "abcd" });
      const otherName = Array.from(files.keys()).find((name) => files.get(name) !== blob)!;
      files.set(otherName, blob);
      const failure = yield* secrets.list(otherProjectId).pipe(Effect.flip);
      assert.include(failure.message, "can't be decrypted");
    }),
  ),
);

it.effect("a different key cannot read existing secrets", () =>
  Effect.gen(function* () {
    let captured: Map<string, Uint8Array> | undefined;
    yield* withSecrets(({ secrets, files }) =>
      secrets
        .set({ projectId, name: "GH_TOKEN", value: VALUE })
        .pipe(Effect.tap(() => Effect.sync(() => void (captured = new Map(files))))),
    );
    const failure = yield* withSecrets(
      ({ secrets, files }) =>
        Effect.gen(function* () {
          for (const [name, blob] of captured!) files.set(name, blob);
          return yield* secrets.list(projectId).pipe(Effect.flip);
        }),
      { key: new Uint8Array(32).fill(4) },
    );
    assert.include(failure.message, "can't be decrypted");
  }),
);

it.effect("validates set: value required on create, kept on update, count and project limits", () =>
  withSecrets(({ secrets }) =>
    Effect.gen(function* () {
      const noValue = yield* secrets.set({ projectId, name: "NEW" }).pipe(Effect.flip);
      assert.include(noValue.message, "value is required");

      const missing = yield* secrets
        .set({ projectId: missingProjectId, name: "NEW", value: VALUE })
        .pipe(Effect.flip);
      assert.include(missing.message, "not found");

      yield* secrets.set({ projectId, name: "TOKEN", value: VALUE });
      yield* secrets.set({ projectId, name: "TOKEN", exposeAs: "file" });
      const [resolved] = (yield* secrets.resolveForThread({ projectId, threadId: thread1 }))
        .secrets;
      assert.deepStrictEqual(resolved, { name: "TOKEN", value: VALUE, exposeAs: "file" });

      for (let index = 1; index < PROJECT_SECRETS_MAX_COUNT; index += 1) {
        yield* secrets.set({ projectId, name: `S_${index}`, value: "abcd" });
      }
      const overflow = yield* secrets
        .set({ projectId, name: "ONE_TOO_MANY", value: "abcd" })
        .pipe(Effect.flip);
      assert.include(overflow.message, "at most");
      // Updating an existing secret stays possible at the limit.
      yield* secrets.set({ projectId, name: "TOKEN", value: "changed-value" });
    }),
  ),
);

it.effect("resolves only the secrets whose scope includes the thread", () =>
  withSecrets(({ secrets }) =>
    Effect.gen(function* () {
      yield* secrets.set({ projectId, name: "EVERYONE", value: "aaaa-1" });
      yield* secrets.set({
        projectId,
        name: "ONLY_ONE",
        value: "bbbb-2",
        scope: { type: "threads", threadIds: [thread1, thread1] },
      });
      const names = (threadId: ThreadId) =>
        secrets
          .resolveForThread({ projectId, threadId })
          .pipe(Effect.map((resolved) => resolved.secrets.map((secret) => secret.name)));
      assert.deepStrictEqual(yield* names(thread1), ["EVERYONE", "ONLY_ONE"]);
      assert.deepStrictEqual(yield* names(thread2), ["EVERYONE"]);
      const listed = (yield* secrets.list(projectId)).secrets.find(
        (secret) => secret.name === "ONLY_ONE",
      );
      assert.deepStrictEqual(listed?.scope, { type: "threads", threadIds: [thread1] });
    }),
  ),
);

it.effect("the fingerprint is keyed, stable, and moves with any value change", () =>
  withSecrets(({ secrets, keyLoads }) =>
    Effect.gen(function* () {
      const fingerprint = (threadId = thread1) =>
        secrets
          .resolveForThread({ projectId, threadId })
          .pipe(Effect.map((resolved) => resolved.fingerprint));

      assert.strictEqual(yield* fingerprint(), "");
      assert.strictEqual(keyLoads.count, 0);

      yield* secrets.set({ projectId, name: "TOKEN", value: "value-one" });
      const first = yield* fingerprint();
      assert.notStrictEqual(first, "");
      assert.isFalse(first.includes("value-one"));
      assert.strictEqual(yield* fingerprint(), first);
      assert.strictEqual(yield* fingerprint(thread2), first);

      yield* secrets.set({ projectId, name: "TOKEN", value: "value-two" });
      const changed = yield* fingerprint();
      assert.notStrictEqual(changed, first);

      yield* secrets.set({ projectId, name: "TOKEN", exposeAs: "file" });
      assert.notStrictEqual(yield* fingerprint(), changed);

      yield* secrets.set({
        projectId,
        name: "OTHER",
        value: "x-y-z-1",
        scope: { type: "threads", threadIds: [thread2] },
      });
      assert.notStrictEqual(yield* fingerprint(thread2), yield* fingerprint(thread1));
    }),
  ),
);

it.effect("redacts every occurrence, longest value first, and ignores short values", () =>
  withSecrets(({ secrets }) =>
    Effect.gen(function* () {
      yield* secrets.set({ projectId, name: "SHORT", value: "abcd" });
      yield* secrets.set({ projectId, name: "LONG", value: "abcdef-long" });
      yield* secrets.set({ projectId, name: "TINY", value: "yes" });
      assert.strictEqual(secrets.redact(thread1, "abcd abcdef-long"), "abcd abcdef-long");
      assert.isFalse(secrets.hasSecrets(thread1));

      yield* secrets.resolveForThread({ projectId, threadId: thread1 });
      assert.isTrue(secrets.hasSecrets(thread1));
      assert.isFalse(secrets.hasSecrets(thread2));
      assert.strictEqual(
        secrets.redact(thread1, "abcdef-long abcd abcdef-long yes"),
        "•••••• •••••• •••••• yes",
      );
      assert.strictEqual(secrets.redact(thread2, "abcdef-long"), "abcdef-long");
      assert.strictEqual(secrets.redact(thread1, "nothing to hide"), "nothing to hide");
    }),
  ),
);

it.effect("pendingSecretPrefix holds back the longest partial value at the end", () =>
  withSecrets(({ secrets }) =>
    Effect.gen(function* () {
      yield* secrets.set({ projectId, name: "A", value: "abcd-first" });
      yield* secrets.set({ projectId, name: "B", value: "abcdef-second" });
      yield* secrets.set({ projectId, name: "TINY", value: "xyz" });
      assert.strictEqual(secrets.pendingSecretPrefix(thread1, "abcd-"), 0);

      yield* secrets.resolveForThread({ projectId, threadId: thread1 });
      assert.strictEqual(secrets.pendingSecretPrefix(thread1, "hello"), 0);
      assert.strictEqual(secrets.pendingSecretPrefix(thread1, "hello abcd"), 4);
      // A and B share the "abcd" prefix; the longest partial match wins.
      assert.strictEqual(secrets.pendingSecretPrefix(thread1, "x abcd-fir"), 8);
      assert.strictEqual(secrets.pendingSecretPrefix(thread1, "x abcdef-secon"), 12);
      // A complete value is the redactor's job, not pending.
      assert.strictEqual(secrets.pendingSecretPrefix(thread1, "abcd-first"), 0);
      // Text shorter than the prefix still counts what it has.
      assert.strictEqual(secrets.pendingSecretPrefix(thread1, "abcd"), 4);
      // Values under the redaction minimum are ignored.
      assert.strictEqual(secrets.pendingSecretPrefix(thread1, "xy"), 0);
      assert.strictEqual(secrets.pendingSecretPrefix(thread2, "abcd"), 0);

      yield* secrets.removeAll(projectId);
      assert.strictEqual(secrets.pendingSecretPrefix(thread1, "abcd"), 0);
    }),
  ),
);

it.effect("removeAll drops the project's secrets and its redactions", () =>
  withSecrets(({ secrets, files }) =>
    Effect.gen(function* () {
      yield* secrets.set({ projectId, name: "TOKEN", value: VALUE });
      yield* secrets.set({ projectId: otherProjectId, name: "KEPT", value: "kept-value" });
      yield* secrets.resolveForThread({ projectId, threadId: thread1 });
      assert.strictEqual(secrets.redact(thread1, VALUE), "••••••");

      yield* secrets.removeAll(projectId);
      assert.strictEqual(files.size, 1);
      assert.strictEqual(secrets.redact(thread1, VALUE), VALUE);
      assert.deepStrictEqual((yield* secrets.list(projectId)).secrets, []);
      assert.strictEqual((yield* secrets.list(otherProjectId)).secrets.length, 1);
    }),
  ),
);

it.effect("remove deletes one secret and the blob when the last one goes", () =>
  withSecrets(({ secrets, files }) =>
    Effect.gen(function* () {
      yield* secrets.set({ projectId, name: "A", value: "aaaa" });
      yield* secrets.set({ projectId, name: "B", value: "bbbb" });
      yield* secrets.remove({ projectId, name: "A" });
      assert.deepStrictEqual(
        (yield* secrets.list(projectId)).secrets.map((secret) => secret.name),
        ["B"],
      );
      yield* secrets.remove({ projectId, name: "B" });
      assert.strictEqual(files.size, 0);
      yield* secrets.remove({ projectId, name: "B" });
    }),
  ),
);

it.effect("reports the key storage the key service chose", () =>
  withSecrets(
    ({ secrets }) =>
      secrets
        .list(projectId)
        .pipe(
          Effect.tap((listed) => Effect.sync(() => assert.strictEqual(listed.keyStorage, "file"))),
        ),
    { storage: "file" },
  ),
);
