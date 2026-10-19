import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addForwardedEnvName,
  buildProjectSecretSetInput,
  containerRuntimePatch,
  describeProjectSecretRow,
  parseCpuLimitInput,
  parseMemoryLimitInput,
  toggleScopeThread,
} from "./containerSettings.logic";

const projectId = ProjectId.make("project-1");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

describe("limit parsing", () => {
  it("treats blank as clearing the limit", () => {
    expect(parseCpuLimitInput("  ")).toEqual({ value: null });
    expect(parseMemoryLimitInput("")).toEqual({ value: null });
  });

  it("accepts the contract's cpu and memory shapes", () => {
    expect(parseCpuLimitInput("0.5")).toEqual({ value: 0.5 });
    expect(parseMemoryLimitInput(" 4g ")).toEqual({ value: "4g" });
    expect(parseMemoryLimitInput("512")).toEqual({ value: "512" });
  });

  it("rejects values the contract would reject", () => {
    expect(parseCpuLimitInput("0")).toHaveProperty("error");
    expect(parseCpuLimitInput("513")).toHaveProperty("error");
    expect(parseCpuLimitInput("two")).toHaveProperty("error");
    expect(parseMemoryLimitInput("4 gigs")).toHaveProperty("error");
  });
});

describe("containerRuntimePatch", () => {
  it("nests only the edited field", () => {
    expect(containerRuntimePatch({ engine: "podman" })).toEqual({
      containerRuntime: { engine: "podman" },
    });
  });
});

describe("addForwardedEnvName", () => {
  it("appends valid, new names", () => {
    expect(addForwardedEnvName(["A"], " NPM_TOKEN ")).toEqual({ names: ["A", "NPM_TOKEN"] });
  });

  it("rejects invalid and duplicate names", () => {
    expect(addForwardedEnvName([], "1BAD")).toHaveProperty("error");
    expect(addForwardedEnvName(["A"], "A")).toHaveProperty("error");
  });
});

describe("buildProjectSecretSetInput", () => {
  const base = {
    projectId,
    name: "API_KEY",
    value: "s3cret",
    exposeAs: "env" as const,
    scope: { type: "all" as const },
    existing: false,
  };

  it("requires a value on create but not on edit", () => {
    expect(buildProjectSecretSetInput({ ...base, value: "" })).toEqual({ error: "Enter a value." });
    const edit = buildProjectSecretSetInput({ ...base, value: "", existing: true });
    expect(edit).toEqual({
      input: { projectId, name: "API_KEY", exposeAs: "env", scope: { type: "all" } },
    });
  });

  it("validates names like ProjectSecretName", () => {
    expect(buildProjectSecretSetInput({ ...base, name: "has-dash" })).toHaveProperty("error");
  });

  it("requires a thread when scoped to threads", () => {
    expect(
      buildProjectSecretSetInput({ ...base, scope: { type: "threads", threadIds: [] } }),
    ).toHaveProperty("error");
  });
});

describe("scope helpers", () => {
  it("toggles threads in and out of a scope", () => {
    const one = toggleScopeThread({ type: "all" }, threadA);
    expect(one).toEqual({ type: "threads", threadIds: [threadA] });
    const two = toggleScopeThread(one, threadB);
    expect(toggleScopeThread(two, threadA)).toEqual({ type: "threads", threadIds: [threadB] });
  });

  it("describes a row without deriving anything from the value", () => {
    expect(
      describeProjectSecretRow({
        name: "API_KEY",
        exposeAs: "both",
        scope: { type: "threads", threadIds: [threadA, threadB] },
        updatedAt: "2026-01-01T00:00:00.000Z" as never,
      }),
    ).toBe("•••••• · Env + file · 2 threads");
  });
});
