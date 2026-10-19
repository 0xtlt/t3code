import { describe, expect, it } from "@effect/vitest";

import { parseJsonc, stripJsonc } from "./Jsonc.ts";

describe("parseJsonc", () => {
  it("reads line and block comments and trailing commas", () => {
    const parsed = parseJsonc(`{
      // the base image
      "image": "node:24", /* inline */
      "containerEnv": { "A": "1", },
      "postCreateCommand": ["npm", "ci",],
    }`);
    expect(parsed).toEqual({
      image: "node:24",
      containerEnv: { A: "1" },
      postCreateCommand: ["npm", "ci"],
    });
  });

  it("leaves comment markers and commas inside strings alone", () => {
    expect(
      parseJsonc('{"url": "https://example.com/a//b", "glob": "/* not a comment */", "c": ",]"}'),
    ).toEqual({ url: "https://example.com/a//b", glob: "/* not a comment */", c: ",]" });
  });

  it("handles escaped quotes inside strings", () => {
    expect(parseJsonc(String.raw`{"a": "say \"// hi\"", /* x */ "b": 1}`)).toEqual({
      a: 'say "// hi"',
      b: 1,
    });
  });

  it("does not fuse tokens around a block comment", () => {
    expect(stripJsonc("[1/* c */2]")).toBe("[1 2]");
  });

  it("accepts a BOM and tolerates an unterminated block comment", () => {
    expect(parseJsonc('﻿{"a": 1}')).toEqual({ a: 1 });
    expect(parseJsonc('{"a": 1} /* open')).toEqual({ a: 1 });
  });

  it("returns undefined for invalid input", () => {
    expect(parseJsonc("{ nope")).toBeUndefined();
    expect(parseJsonc("")).toBeUndefined();
  });
});
