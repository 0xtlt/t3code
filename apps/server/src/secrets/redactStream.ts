import type { ThreadId } from "@t3tools/contracts";

import type { ProjectSecrets } from "./ProjectSecrets.ts";

export type SecretRedactor = Pick<ProjectSecrets["Service"], "redact" | "pendingSecretPrefix">;

/**
 * Redacts one chunk of a stream. A secret split across two chunks would
 * escape per-chunk redaction, so the tail that could still grow into a secret
 * stays in `carry` and is prepended to the next chunk. Threads without
 * secrets never carry anything.
 */
export function redactStreamChunk(
  secrets: SecretRedactor,
  threadId: ThreadId,
  carry: string,
  chunk: string,
): { readonly text: string; readonly carry: string } {
  const combined = carry + chunk;
  const held = secrets.pendingSecretPrefix(threadId, combined);
  if (held === 0) return { text: secrets.redact(threadId, combined), carry: "" };
  const split = combined.length - held;
  return {
    text: secrets.redact(threadId, combined.slice(0, split)),
    carry: combined.slice(split),
  };
}
