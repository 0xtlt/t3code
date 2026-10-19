import { describe, expect, it } from "vite-plus/test";

import {
  canRebuildContainer,
  canStopContainer,
  containerRestartHint,
} from "./ThreadContainerControl.logic";

describe("thread container actions", () => {
  it("only stops a running container", () => {
    expect(canStopContainer({ state: "running" })).toBe(true);
    expect(canStopContainer({ state: "stopped" })).toBe(false);
  });

  it("rebuilds anything that exists and is not mid-prepare", () => {
    expect(canRebuildContainer({ state: "stopped" })).toBe(true);
    expect(canRebuildContainer({ state: "error" })).toBe(true);
    expect(canRebuildContainer({ state: "absent" })).toBe(false);
    expect(canRebuildContainer({ state: "preparing" })).toBe(false);
  });

  it("explains how a stopped container comes back", () => {
    expect(containerRestartHint({ state: "stopped" })).toMatch(/next agent turn or terminal/);
    expect(containerRestartHint({ state: "running" })).toMatch(/starts it again/);
    expect(containerRestartHint({ state: "preparing" })).toBeNull();
  });
});
