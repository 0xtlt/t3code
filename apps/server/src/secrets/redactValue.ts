import type { ThreadId } from "@t3tools/contracts";

import type { ProjectSecrets } from "./ProjectSecrets.ts";

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Applies `redact` to every string inside plain objects and arrays. Anything
 * else (dates, class instances, numbers) is left alone, and a value with
 * nothing to mask comes back as the same reference.
 */
export function redactDeep<A>(value: A, redact: (text: string) => string): A {
  if (typeof value === "string") return redact(value) as A;
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item: unknown) => {
      const redacted = redactDeep(item, redact);
      if (redacted !== item) changed = true;
      return redacted;
    });
    return (changed ? next : value) as A;
  }
  if (!isPlainObject(value)) return value;
  let next: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(value)) {
    const redacted = redactDeep(item, redact);
    if (redacted !== item) {
      next ??= { ...value };
      next[key] = redacted;
    }
  }
  return (next ?? value) as A;
}

/**
 * Masks a thread's project secrets in any value that is about to be stored.
 * Threads without secrets cost one Map lookup, not a walk of the value.
 */
export const makeThreadValueRedactor =
  (secrets: Pick<ProjectSecrets["Service"], "hasSecrets" | "redact">) =>
  (value: unknown, threadId: ThreadId): unknown =>
    secrets.hasSecrets(threadId)
      ? redactDeep(value, (text) => secrets.redact(threadId, text))
      : value;
