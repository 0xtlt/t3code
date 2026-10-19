import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { redactStreamChunk, type SecretRedactor } from "./redactStream.ts";

/**
 * Redacts the live output chunks of provider commands, which skip event
 * ingestion. Only container threads can have project secrets; every other
 * thread costs one Map lookup per chunk. A tail that may be the start of a
 * secret split across chunks is held back per command until the next chunk.
 */
export function makeLiveOutputRedactor(input: {
  readonly secrets: SecretRedactor | undefined;
  readonly inContainer: (threadId: ThreadId) => Effect.Effect<boolean>;
}) {
  // A thread's container flag never changes, so one lookup per thread is enough.
  const containerThreads = new Map<ThreadId, boolean>();
  // Only non-empty tails are kept.
  const carries = new Map<string, string>();
  const keyOf = (threadId: ThreadId, itemId: string) => `${threadId}\0${itemId}`;

  return {
    redact: (chunk: {
      readonly threadId: ThreadId;
      readonly itemId: string;
      readonly chunk: string;
    }) =>
      Effect.gen(function* () {
        const secrets = input.secrets;
        if (secrets === undefined) return chunk.chunk;
        let container = containerThreads.get(chunk.threadId);
        if (container === undefined) {
          container = yield* input.inContainer(chunk.threadId);
          containerThreads.set(chunk.threadId, container);
        }
        if (!container) return chunk.chunk;
        const key = keyOf(chunk.threadId, chunk.itemId);
        const redacted = redactStreamChunk(
          secrets,
          chunk.threadId,
          carries.get(key) ?? "",
          chunk.chunk,
        );
        if (redacted.carry === "") carries.delete(key);
        else carries.set(key, redacted.carry);
        return redacted.text;
      }),
    /** The command settled; its persisted output (redacted at ingestion) replaces the live tail. */
    release: (threadId: ThreadId, itemId: string) => {
      carries.delete(keyOf(threadId, itemId));
    },
  };
}
