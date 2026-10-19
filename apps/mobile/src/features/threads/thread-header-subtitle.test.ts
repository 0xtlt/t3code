import { describe, expect, it } from "vite-plus/test";

import { buildThreadHeaderSubtitle } from "./thread-header-subtitle";

describe("buildThreadHeaderSubtitle", () => {
  it("marks container threads", () => {
    expect(
      buildThreadHeaderSubtitle({ projectTitle: "App", environmentLabel: "Mac", container: true }),
    ).toBe("App · Mac · Container");
  });

  it("leaves other threads unchanged", () => {
    expect(
      buildThreadHeaderSubtitle({
        projectTitle: "App",
        environmentLabel: undefined,
        container: undefined,
      }),
    ).toBe("App");
  });
});
