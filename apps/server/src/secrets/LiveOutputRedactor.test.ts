import { describe, expect, it } from "@effect/vitest";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { makeLiveOutputRedactor } from "./LiveOutputRedactor.ts";

const secret = "hunter2";
const secrets = {
  redact: (_threadId: ThreadId, text: string) => text.replaceAll(secret, "***"),
  pendingSecretPrefix: (_threadId: ThreadId, text: string) => {
    for (let length = Math.min(secret.length - 1, text.length); length > 0; length--) {
      if (secret.startsWith(text.slice(text.length - length))) return length;
    }
    return 0;
  },
};
const container = "container-thread" as ThreadId;
const host = "host-thread" as ThreadId;
const inContainer = (threadId: ThreadId) => Effect.succeed(threadId === container);

describe("makeLiveOutputRedactor", () => {
  it.effect("masks a secret split across a container thread's chunks", () =>
    Effect.gen(function* () {
      const redactor = makeLiveOutputRedactor({ secrets, inContainer });
      const out = [];
      for (const chunk of ["token=hun", "ter", "2\n"]) {
        out.push(yield* redactor.redact({ threadId: container, itemId: "item", chunk }));
      }
      expect(out.join("")).toBe("token=***\n");
    }),
  );

  it.effect("keeps commands apart and drops a held tail on release", () =>
    Effect.gen(function* () {
      const redactor = makeLiveOutputRedactor({ secrets, inContainer });
      expect(yield* redactor.redact({ threadId: container, itemId: "a", chunk: "hun" })).toBe("");
      expect(yield* redactor.redact({ threadId: container, itemId: "b", chunk: "ter2" })).toBe(
        "ter2",
      );
      redactor.release(container, "a");
      expect(yield* redactor.redact({ threadId: container, itemId: "a", chunk: "ter2" })).toBe(
        "ter2",
      );
    }),
  );

  it.effect("passes other threads and servers without secrets through untouched", () =>
    Effect.gen(function* () {
      const redactor = makeLiveOutputRedactor({ secrets, inContainer });
      expect(yield* redactor.redact({ threadId: host, itemId: "a", chunk: "hunter2" })).toBe(
        "hunter2",
      );
      const without = makeLiveOutputRedactor({ secrets: undefined, inContainer });
      expect(yield* without.redact({ threadId: container, itemId: "a", chunk: "hunter2" })).toBe(
        "hunter2",
      );
    }),
  );
});
