import { describe, expect, it } from "@effect/vitest";

import { outputTail, parseEngineVersion, splitLines } from "./ContainerEngine.ts";

describe("parseEngineVersion", () => {
  it("prefers the server version and falls back to the client's", () => {
    expect(
      parseEngineVersion(
        JSON.stringify({ Client: { Version: "29.0.0" }, Server: { Version: "28.1.0" } }),
      ),
    ).toBe("28.1.0");
    expect(parseEngineVersion(JSON.stringify({ Client: { Version: "5.2.0" } }))).toBe("5.2.0");
  });

  it("returns undefined for anything else", () => {
    expect(parseEngineVersion("not json")).toBeUndefined();
    expect(parseEngineVersion("null")).toBeUndefined();
    expect(parseEngineVersion("{}")).toBeUndefined();
  });
});

describe("splitLines", () => {
  it("keeps a partial trailing line pending across chunks", () => {
    const state = { pending: "" };
    expect(splitLines(state, "one\ntw")).toEqual(["one"]);
    expect(splitLines(state, "o\r\nthree\n")).toEqual(["two", "three"]);
    expect(state.pending).toBe("");
  });

  it("treats progress carriage returns as line breaks and drops empty lines", () => {
    expect(splitLines({ pending: "" }, "a\r\r\nb\n")).toEqual(["a", "b"]);
  });
});

describe("outputTail", () => {
  it("keeps the last lines and caps the length", () => {
    const text = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    const tail = outputTail(text);
    expect(tail.split("\n")).toHaveLength(12);
    expect(tail.endsWith("line 39")).toBe(true);
    expect(outputTail("x".repeat(5000)).length).toBe(1500);
  });
});
