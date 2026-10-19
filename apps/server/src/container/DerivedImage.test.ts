import { describe, expect, it } from "@effect/vitest";

import {
  baseImageTag,
  derivedImageTag,
  LAYER_VERSION,
  renderDerivedDockerfile,
} from "./DerivedImage.ts";

const full = { toolchain: true };

describe("renderDerivedDockerfile", () => {
  it("installs missing CLIs with npm, only when absent, and prepares the home directory", () => {
    const dockerfile = renderDerivedDockerfile({ baseImage: "node:24-bookworm", layer: full });
    expect(dockerfile.startsWith("FROM node:24-bookworm\nUSER root\n")).toBe(true);
    expect(dockerfile).toContain("command -v claude");
    expect(dockerfile).toContain("@anthropic-ai/claude-code");
    expect(dockerfile).toContain("command -v codex");
    expect(dockerfile).toContain("@openai/codex");
    expect(dockerfile).toContain("npm install -g $missing");
    expect(dockerfile).toContain("has no npm");
    expect(dockerfile).toContain("mkdir -p /t3home && chmod 1777 /t3home");
  });

  it("ensures git and certificates through whichever package manager exists", () => {
    const dockerfile = renderDerivedDockerfile({ baseImage: "x", layer: full });
    for (const manager of ["apt-get", "apk", "dnf", "microdnf", "yum"]) {
      expect(dockerfile).toContain(`command -v ${manager}`);
    }
    expect(dockerfile).toContain("ca-certificates");
  });

  it("keeps every RUN a single continued shell line", () => {
    const dockerfile = renderDerivedDockerfile({ baseImage: "x", layer: full });
    for (const block of dockerfile.split("\nRUN ").slice(1)) {
      const lines = block.trimEnd().split("\n");
      for (const line of lines.slice(0, -1)) expect(line.endsWith("\\")).toBe(true);
    }
  });

  it("skips the toolchain when asked", () => {
    const dockerfile = renderDerivedDockerfile({
      baseImage: "alpine:3.20",
      layer: { toolchain: false },
    });
    expect(dockerfile).not.toContain("npm");
    expect(dockerfile).toContain("chmod 1777 /t3home");
  });
});

describe("image tags", () => {
  const image = { kind: "image", image: "node:24" } as const;
  const dockerfile = (content: string, args: Record<string, string> = {}) =>
    ({
      kind: "dockerfile",
      dockerfile: "/w/Dockerfile",
      context: "/w",
      buildArgs: args,
      dockerfileContent: content,
    }) as const;

  it("tags by hash and is stable", () => {
    expect(derivedImageTag(image, full)).toMatch(/^t3code-env:[0-9a-f]{16}$/);
    expect(derivedImageTag(image, full)).toBe(derivedImageTag({ ...image }, full));
    expect(LAYER_VERSION).toBeGreaterThan(0);
  });

  it("changes with the base, the Dockerfile contents, build args, and the layer", () => {
    const tags = new Set([
      derivedImageTag(image, full),
      derivedImageTag({ kind: "image", image: "node:22" }, full),
      derivedImageTag(image, { toolchain: false }),
      derivedImageTag(dockerfile("FROM a"), full),
      derivedImageTag(dockerfile("FROM b"), full),
      derivedImageTag(dockerfile("FROM a", { X: "1" }), full),
    ]);
    expect(tags.size).toBe(6);
  });

  it("ignores build arg order", () => {
    expect(baseImageTag(dockerfile("x", { A: "1", B: "2" }))).toBe(
      baseImageTag(dockerfile("x", { B: "2", A: "1" })),
    );
  });
});
