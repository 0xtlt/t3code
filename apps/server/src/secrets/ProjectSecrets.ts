import {
  PROJECT_SECRETS_MAX_COUNT,
  ProjectSecretExposure,
  ProjectSecretScope,
  ProjectSecretsError,
  type ProjectId,
  type ProjectSecretRemoveInput,
  type ProjectSecretSetInput,
  type ProjectSecretSummary,
  type ProjectSecretsListResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no AES-GCM or HMAC.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectSecretsKey from "./ProjectSecretsKey.ts";

export interface ResolvedProjectSecret {
  readonly name: string;
  readonly value: string;
  readonly exposeAs: ProjectSecretExposure;
}

/**
 * Encrypted per-project secrets for container threads. Values are AES-256-GCM
 * encrypted at rest; the key lives in the OS keychain when one is reachable,
 * otherwise in a 0600 file under the secrets directory. No method that serves
 * a transport returns a value. See docs/internals/container-threads.md.
 */
export class ProjectSecrets extends Context.Service<
  ProjectSecrets,
  {
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<ProjectSecretsListResult, ProjectSecretsError>;
    readonly set: (
      input: ProjectSecretSetInput,
    ) => Effect.Effect<ProjectSecretSummary, ProjectSecretsError>;
    readonly remove: (input: ProjectSecretRemoveInput) => Effect.Effect<void, ProjectSecretsError>;
    /** Drops every secret of a deleted project. */
    readonly removeAll: (projectId: ProjectId) => Effect.Effect<void>;
    /**
     * Server-internal: the plaintext secrets in scope for a thread, plus an
     * HMAC fingerprint (keyed, so it reveals nothing about values) that changes
     * whenever any of them changes. Also primes `redact` for the thread. The
     * fingerprint is the empty string when nothing is in scope, and that case
     * never touches the encryption key.
     */
    readonly resolveForThread: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<
      { readonly secrets: ReadonlyArray<ResolvedProjectSecret>; readonly fingerprint: string },
      ProjectSecretsError
    >;
    /**
     * Replaces every known secret value of the thread in `text` with a mask.
     * Synchronous and a no-op for threads without resolved secrets, so it is
     * cheap enough for terminal output and provider events.
     */
    readonly redact: (threadId: ThreadId, text: string) => string;
    /** Whether `redact` has anything to mask for the thread. O(1). */
    readonly hasSecrets: (threadId: ThreadId) => boolean;
    /**
     * Length of the longest suffix of `text` that is a proper prefix of one of
     * the thread's secret values; 0 for threads without secrets. A streaming
     * redactor holds that suffix back until the next chunk shows whether the
     * value continues. Synchronous and O(1) for threads without secrets.
     */
    readonly pendingSecretPrefix: (threadId: ThreadId, text: string) => number;
  }
>()("t3/secrets/ProjectSecrets") {}

const BLOB_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;
const MASK = "••••••";
/** Shorter values would mask ordinary text ("1", "yes") and prove nothing. */
const MIN_REDACTED_LENGTH = 4;

const StoredDocument = Schema.fromJsonString(
  Schema.Struct({
    secrets: Schema.Record(
      Schema.String,
      Schema.Struct({
        value: Schema.String,
        exposeAs: ProjectSecretExposure,
        scope: ProjectSecretScope,
        updatedAt: Schema.String,
      }),
    ),
  }),
);
type StoredDocument = typeof StoredDocument.Type;
const encodeDocument = Schema.encodeSync(StoredDocument);
const decodeDocument = Schema.decodeUnknownOption(StoredDocument);

// Hashed rather than sanitized: two ids differing only in characters a file
// name cannot hold would otherwise share (and overwrite) one blob.
const storeName = (projectId: ProjectId) =>
  `project-secrets-${NodeCrypto.createHash("sha256").update(projectId).digest("hex").slice(0, 32)}`;

// The store name is authenticated data, so a blob copied over another
// project's file fails to decrypt instead of serving the wrong secrets.
const encrypt = (key: Uint8Array, name: string, plaintext: string): Uint8Array => {
  const iv = NodeCrypto.randomBytes(IV_BYTES);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([BLOB_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
};

const decrypt = (key: Uint8Array, name: string, blob: Uint8Array): Option.Option<string> => {
  if (blob.length < HEADER_BYTES || blob[0] !== BLOB_VERSION) return Option.none();
  try {
    const decipher = NodeCrypto.createDecipheriv(
      "aes-256-gcm",
      key,
      blob.subarray(1, 1 + IV_BYTES),
    );
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(blob.subarray(1 + IV_BYTES, HEADER_BYTES));
    return Option.some(
      Buffer.concat([decipher.update(blob.subarray(HEADER_BYTES)), decipher.final()]).toString(
        "utf8",
      ),
    );
  } catch {
    // Wrong key and tampering both fail the auth tag; callers treat them alike.
    return Option.none();
  }
};

type ReadResult =
  | { readonly _tag: "empty" }
  | { readonly _tag: "ok"; readonly document: StoredDocument }
  | { readonly _tag: "undecryptable" };

const toSummary = (
  name: string,
  entry: StoredDocument["secrets"][string],
): ProjectSecretSummary => ({
  name,
  exposeAs: entry.exposeAs,
  scope: entry.scope,
  updatedAt: entry.updatedAt,
});

const inScope = (entry: StoredDocument["secrets"][string], threadId: ThreadId) =>
  entry.scope.type === "all" || entry.scope.threadIds.includes(threadId);

const undecryptableError = () =>
  new ProjectSecretsError({
    message:
      "The secrets for this project can't be decrypted; delete and re-create them. The encryption key may have been lost.",
  });

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const keys = yield* ProjectSecretsKey.ProjectSecretsKey;
  const locks = yield* KeyedLock.make<ProjectId>();

  // Per thread: the values to mask, longest first so a value that is a prefix
  // of another cannot leave the longer one's tail in the clear.
  const redactions = new Map<
    ThreadId,
    { readonly projectId: ProjectId; readonly values: ReadonlyArray<string> }
  >();

  const loadKey = keys.load.pipe(
    Effect.catchTags({
      ProjectSecretsKeyError: (error) =>
        Effect.logWarning("Project secrets key could not be loaded", {
          errorTag: error._tag,
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new ProjectSecretsError({
                message: "The project secrets encryption key is unavailable.",
              }),
            ),
          ),
        ),
    }),
  );

  // Storage failures carry paths and platform detail in their cause; callers
  // get a fixed message and the log gets only the tag.
  const storageFailure = (operation: string) => (error: ServerSecretStore.SecretStoreError) =>
    Effect.logWarning("Project secrets storage failed", {
      operation,
      errorTag: error._tag,
    }).pipe(
      Effect.andThen(
        Effect.fail(
          new ProjectSecretsError({ message: `Project secrets could not be ${operation}.` }),
        ),
      ),
    );

  const readBlob = (projectId: ProjectId) =>
    store.get(storeName(projectId)).pipe(Effect.catch(storageFailure("read")));

  const readDocument = (projectId: ProjectId, key: Uint8Array) =>
    readBlob(projectId).pipe(
      Effect.map((blob): ReadResult => {
        if (Option.isNone(blob)) return { _tag: "empty" };
        const document = Option.flatMap(decrypt(key, storeName(projectId), blob.value), (text) =>
          decodeDocument(text),
        );
        return Option.isSome(document)
          ? { _tag: "ok", document: document.value }
          : { _tag: "undecryptable" };
      }),
    );

  const writeDocument = (projectId: ProjectId, key: Uint8Array, document: StoredDocument) =>
    Object.keys(document.secrets).length === 0
      ? store.remove(storeName(projectId)).pipe(Effect.catch(storageFailure("saved")))
      : store
          .set(storeName(projectId), encrypt(key, storeName(projectId), encodeDocument(document)))
          .pipe(Effect.catch(storageFailure("saved")));

  const readableDocument = (projectId: ProjectId, key: Uint8Array) =>
    readDocument(projectId, key).pipe(
      Effect.flatMap((result) =>
        result._tag === "undecryptable"
          ? Effect.fail(undecryptableError())
          : Effect.succeed(result._tag === "ok" ? result.document : { secrets: {} }),
      ),
    );

  const list: ProjectSecrets["Service"]["list"] = Effect.fn("ProjectSecrets.list")(
    function* (projectId) {
      const { key, storage } = yield* loadKey;
      const document = yield* readableDocument(projectId, key);
      return {
        secrets: Object.entries(document.secrets)
          .map(([name, entry]) => toSummary(name, entry))
          .sort((left, right) => left.name.localeCompare(right.name)),
        keyStorage: storage,
      };
    },
  );

  const set: ProjectSecrets["Service"]["set"] = Effect.fn("ProjectSecrets.set")(function* (input) {
    const project = yield* projects
      .get(input.projectId)
      .pipe(
        Effect.mapError(
          () => new ProjectSecretsError({ message: "The project could not be looked up." }),
        ),
      );
    if (Option.isNone(project)) {
      return yield* new ProjectSecretsError({ message: "The project was not found." });
    }
    const { key } = yield* loadKey;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    return yield* locks.withLock(
      input.projectId,
      Effect.gen(function* () {
        const document = yield* readableDocument(input.projectId, key);
        const existing = document.secrets[input.name];
        if (existing === undefined) {
          if (input.value === undefined) {
            return yield* new ProjectSecretsError({
              message: "A value is required to create a secret.",
            });
          }
          if (Object.keys(document.secrets).length >= PROJECT_SECRETS_MAX_COUNT) {
            return yield* new ProjectSecretsError({
              message: `A project can hold at most ${PROJECT_SECRETS_MAX_COUNT} secrets.`,
            });
          }
        }
        const scope = input.scope ?? existing?.scope ?? { type: "all" as const };
        const entry = {
          value: input.value ?? existing?.value ?? "",
          exposeAs: input.exposeAs ?? existing?.exposeAs ?? "env",
          scope:
            scope.type === "all"
              ? scope
              : { type: "threads" as const, threadIds: [...new Set(scope.threadIds)] },
          updatedAt,
        };
        yield* writeDocument(input.projectId, key, {
          secrets: { ...document.secrets, [input.name]: entry },
        });
        return toSummary(input.name, entry);
      }),
    );
  });

  const remove: ProjectSecrets["Service"]["remove"] = Effect.fn("ProjectSecrets.remove")(
    function* (input) {
      const { key } = yield* loadKey;
      yield* locks.withLock(
        input.projectId,
        Effect.gen(function* () {
          const result = yield* readDocument(input.projectId, key);
          if (result._tag === "empty") return;
          // Nothing in an unreadable blob can be listed or kept, so removing
          // any name clears it: this is how a project recovers from a lost key.
          if (result._tag === "undecryptable") {
            return yield* store
              .remove(storeName(input.projectId))
              .pipe(Effect.catch(storageFailure("removed")));
          }
          yield* writeDocument(input.projectId, key, {
            secrets: Object.fromEntries(
              Object.entries(result.document.secrets).filter(([name]) => name !== input.name),
            ),
          });
        }),
      );
    },
  );

  const removeAll: ProjectSecrets["Service"]["removeAll"] = Effect.fn("ProjectSecrets.removeAll")(
    function* (projectId) {
      for (const [threadId, entry] of redactions) {
        if (entry.projectId === projectId) redactions.delete(threadId);
      }
      yield* locks.withLock(projectId, store.remove(storeName(projectId))).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Project secrets of a deleted project could not be removed", {
            errorTag: error._tag,
          }),
        ),
      );
    },
  );

  const resolveForThread: ProjectSecrets["Service"]["resolveForThread"] = Effect.fn(
    "ProjectSecrets.resolveForThread",
  )(function* (input) {
    const none = { secrets: [], fingerprint: "" };
    // No blob means no key is needed, so projects without secrets never reach
    // the keychain.
    if (Option.isNone(yield* readBlob(input.projectId))) {
      redactions.delete(input.threadId);
      return none;
    }
    const { key } = yield* loadKey;
    const document = yield* readableDocument(input.projectId, key);
    const secrets = Object.entries(document.secrets)
      .filter(([, entry]) => inScope(entry, input.threadId))
      .map(([name, entry]) => ({ name, value: entry.value, exposeAs: entry.exposeAs }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const values = secrets
      .map((secret) => secret.value)
      .filter((value) => value.length >= MIN_REDACTED_LENGTH)
      .sort((left, right) => right.length - left.length);
    if (values.length === 0) redactions.delete(input.threadId);
    else redactions.set(input.threadId, { projectId: input.projectId, values });
    if (secrets.length === 0) return none;
    const fingerprintKey = NodeCrypto.createHmac("sha256", key)
      .update("t3code-project-secrets-fingerprint")
      .digest();
    const fingerprint = NodeCrypto.createHmac("sha256", fingerprintKey)
      .update(
        // Length-prefixed so no choice of names and values can collide with another.
        secrets
          .map(
            (secret) =>
              `${secret.name.length}:${secret.name}${secret.exposeAs}:${secret.value.length}:${secret.value}`,
          )
          .join("\n"),
      )
      .digest("hex");
    return { secrets, fingerprint };
  });

  const hasSecrets: ProjectSecrets["Service"]["hasSecrets"] = (threadId) =>
    redactions.has(threadId);

  const redact: ProjectSecrets["Service"]["redact"] = (threadId, text) => {
    const entry = redactions.get(threadId);
    if (entry === undefined) return text;
    let redacted = text;
    for (const value of entry.values) redacted = redacted.replaceAll(value, MASK);
    return redacted;
  };

  const pendingSecretPrefix: ProjectSecrets["Service"]["pendingSecretPrefix"] = (
    threadId,
    text,
  ) => {
    const entry = redactions.get(threadId);
    if (entry === undefined) return 0;
    let longest = 0;
    for (const value of entry.values) {
      // A full match is not pending: `redact` masks it, and a longer value
      // that continues it is covered by its own entry.
      const limit = Math.min(text.length, value.length - 1);
      for (let length = limit; length > longest; length -= 1) {
        if (text.endsWith(value.slice(0, length))) {
          longest = length;
          break;
        }
      }
    }
    return longest;
  };

  return ProjectSecrets.of({
    list,
    set,
    remove,
    removeAll,
    resolveForThread,
    redact,
    hasSecrets,
    pendingSecretPrefix,
  });
});

export const layer = Layer.effect(ProjectSecrets, make);
