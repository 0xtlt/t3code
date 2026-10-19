import type { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { redactStreamChunk } from "./redactStream.ts";
import { redactDeep } from "./redactValue.ts";

const thread = "thread-1" as ThreadId;

/** Masks `secret`; reports the longest suffix that is a proper prefix of it. */
const redactorFor = (secret: string | undefined) => ({
  redact: (_threadId: ThreadId, text: string) =>
    secret === undefined ? text : text.replaceAll(secret, "***"),
  pendingSecretPrefix: (_threadId: ThreadId, text: string) => {
    if (secret === undefined) return 0;
    for (let length = Math.min(secret.length - 1, text.length); length > 0; length--) {
      if (secret.startsWith(text.slice(text.length - length))) return length;
    }
    return 0;
  },
});

const run = (secret: string | undefined, chunks: ReadonlyArray<string>) => {
  const redactor = redactorFor(secret);
  let carry = "";
  let out = "";
  for (const chunk of chunks) {
    const result = redactStreamChunk(redactor, thread, carry, chunk);
    carry = result.carry;
    out += result.text;
  }
  return { out, carry };
};

describe("redactStreamChunk", () => {
  it("masks a secret that arrives in one chunk", () => {
    expect(run("hunter2", ["token=hunter2 done"]).out).toBe("token=*** done");
  });

  it("masks a secret split across chunk boundaries", () => {
    expect(run("hunter2", ["token=hun", "ter", "2 done"]).out).toBe("token=*** done");
  });

  it("releases a held tail once it turns out not to be the secret", () => {
    const result = run("hunter2", ["abc hun", "gry"]);
    expect(result.out).toBe("abc hungry");
    expect(result.carry).toBe("");
  });

  it("passes everything straight through when the thread has no secrets", () => {
    const result = run(undefined, ["a", "b"]);
    expect(result).toEqual({ out: "ab", carry: "" });
  });
});

describe("redactDeep", () => {
  const mask = (text: string) => text.replaceAll("hunter2", "***");

  it("masks strings inside nested plain objects and arrays", () => {
    expect(redactDeep({ a: ["x hunter2", { b: "hunter2" }], n: 1 }, mask)).toEqual({
      a: ["x ***", { b: "***" }],
      n: 1,
    });
  });

  it("returns the same reference when nothing changed and leaves class instances alone", () => {
    const when = DateTime.makeUnsafe(0);
    const value = { a: ["clean"], when };
    expect(redactDeep(value, mask)).toBe(value);
  });
});
