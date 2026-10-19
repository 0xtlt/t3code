import { describe, expect, it } from "@effect/vitest";

import {
  composeDefinition,
  DEFAULT_CONTAINER_IMAGE,
  hashDefinition,
  type ComposeInput,
  type ContainerDefinition,
} from "./ContainerDefinition.ts";

const worktreePath = "/work/repo";
const runtime = { cpus: null, memory: null, forwardEnv: [] } as const;

const compose = (input: Partial<ComposeInput>): ContainerDefinition => {
  const result = composeDefinition({
    worktreePath,
    t3: undefined,
    devcontainer: undefined,
    runtime,
    ...input,
  });
  if (!result.ok) throw new Error(result.message);
  return result.definition;
};

const devcontainer = (
  config: Record<string, unknown>,
  relativePath = ".devcontainer/devcontainer.json",
) => ({
  relativePath,
  directory: `${worktreePath}/${relativePath.replace(/\/[^/]*$/, "")}`,
  config,
});

describe("composeDefinition", () => {
  it("falls back to the default image", () => {
    const definition = compose({});
    expect(definition.base).toEqual({ kind: "image", image: DEFAULT_CONTAINER_IMAGE });
    expect(definition.source).toBe("default");
    expect(definition.network).toBe("open");
  });

  it("prefers t3.json image over the devcontainer", () => {
    const definition = compose({
      t3: { image: "python:3.13" },
      devcontainer: devcontainer({ image: "node:20" }),
    });
    expect(definition.base).toEqual({ kind: "image", image: "python:3.13" });
    expect(definition.source).toBe("t3.json");
  });

  it("uses the devcontainer image when t3.json sets no base", () => {
    const definition = compose({ devcontainer: devcontainer({ image: "node:20" }) });
    expect(definition.base).toEqual({ kind: "image", image: "node:20" });
    expect(definition.source).toBe(".devcontainer/devcontainer.json");
  });

  it("resolves devcontainer build paths against the devcontainer folder", () => {
    const definition = compose({
      devcontainer: devcontainer({
        build: { dockerfile: "Dockerfile", context: "..", args: { NODE: "24", N: 3 } },
      }),
    });
    expect(definition.base).toMatchObject({
      kind: "dockerfile",
      dockerfile: "/work/repo/.devcontainer/Dockerfile",
      context: "/work/repo",
      buildArgs: { NODE: "24" },
    });
  });

  it("defaults the devcontainer build context to its folder, and reads legacy dockerFile", () => {
    const definition = compose({ devcontainer: devcontainer({ dockerFile: "Dockerfile.dev" }) });
    expect(definition.base).toMatchObject({
      dockerfile: "/work/repo/.devcontainer/Dockerfile.dev",
      context: "/work/repo/.devcontainer",
    });
  });

  it("resolves t3.json dockerfile paths against the repository root", () => {
    const definition = compose({
      t3: { dockerfile: "docker/dev.Dockerfile", buildArgs: { A: "b" } },
    });
    expect(definition.base).toMatchObject({
      kind: "dockerfile",
      dockerfile: "/work/repo/docker/dev.Dockerfile",
      context: "/work/repo/docker",
      buildArgs: { A: "b" },
    });
  });

  it("rejects build paths that leave the worktree", () => {
    const result = composeDefinition({
      worktreePath,
      t3: { dockerfile: "Dockerfile", context: "../../.." },
      devcontainer: undefined,
      runtime,
    });
    expect(result).toMatchObject({ ok: false });
    const viaDevcontainer = composeDefinition({
      worktreePath,
      t3: undefined,
      devcontainer: devcontainer({ build: { dockerfile: "Dockerfile", context: "../../../.." } }),
      runtime,
    });
    expect(viaDevcontainer).toMatchObject({ ok: false });
  });

  it("accepts postCreateCommand as a string, an array, or an object", () => {
    expect(compose({ devcontainer: devcontainer({ postCreateCommand: "npm ci" }) }).setup).toEqual([
      { kind: "shell", command: "npm ci" },
    ]);
    expect(
      compose({ devcontainer: devcontainer({ postCreateCommand: ["npm", "ci"] }) }).setup,
    ).toEqual([{ kind: "exec", argv: ["npm", "ci"] }]);
    expect(
      compose({
        devcontainer: devcontainer({
          postCreateCommand: { install: "npm ci", db: ["make", "db"] },
        }),
      }).setup,
    ).toEqual([
      { kind: "shell", command: "npm ci" },
      { kind: "exec", argv: ["make", "db"] },
    ]);
  });

  it("lets t3.json setupCommand replace postCreateCommand", () => {
    const definition = compose({
      t3: { setupCommand: "make setup" },
      devcontainer: devcontainer({ postCreateCommand: "npm ci" }),
    });
    expect(definition.setup).toEqual([{ kind: "shell", command: "make setup" }]);
  });

  it("merges env with t3.json winning and expands workspace variables", () => {
    const definition = compose({
      t3: { env: { B: "t3", C: "${containerWorkspaceFolder}/bin" } },
      devcontainer: devcontainer({
        image: "node:20",
        containerEnv: { A: "a", B: "dev" },
        remoteEnv: { D: "${localWorkspaceFolderBasename}" },
      }),
    });
    expect(definition.env).toEqual({ A: "a", B: "t3", C: "/work/repo/bin", D: "repo" });
    expect(definition.notes).toEqual([]);
  });

  it("reports unsupported devcontainer keys and variables instead of ignoring them", () => {
    const definition = compose({
      devcontainer: devcontainer({
        image: "node:20",
        features: { "ghcr.io/devcontainers/features/go:1": {} },
        dockerComposeFile: "compose.yml",
        postStartCommand: "x",
        containerEnv: { HOME_DIR: "${localEnv:HOME}" },
        customizations: { vscode: {} },
      }),
    });
    expect(definition.notes).toHaveLength(2);
    expect(definition.notes[0]).toContain("`features`");
    expect(definition.notes[0]).toContain("`dockerComposeFile`");
    expect(definition.notes[0]).toContain("`postStartCommand`");
    expect(definition.notes[0]).not.toContain("customizations");
    expect(definition.notes[1]).toContain("${localWorkspaceFolder}");
  });

  it("layers limits: t3.json over machine settings", () => {
    const withMachine = { cpus: 2, memory: "2g", forwardEnv: ["NPM_TOKEN"] };
    expect(compose({ runtime: withMachine })).toMatchObject({ cpus: 2, memory: "2g" });
    const definition = compose({
      runtime: withMachine,
      t3: {
        cpus: 4,
        forwardEnv: ["GH_TOKEN", "NPM_TOKEN"],
        network: "restricted",
        allowedHosts: ["a.test"],
      },
    });
    expect(definition).toMatchObject({
      cpus: 4,
      memory: "2g",
      forwardEnv: ["NPM_TOKEN", "GH_TOKEN"],
      network: "restricted",
      allowedHosts: ["a.test"],
    });
  });
});

describe("hashDefinition", () => {
  it("is stable across key order and ignores forwardEnv and notes", () => {
    const a = compose({ t3: { image: "x", env: { A: "1", B: "2" } } });
    const b = compose({ t3: { env: { B: "2", A: "1" }, image: "x", forwardEnv: ["TOKEN"] } });
    expect(hashDefinition(a)).toBe(hashDefinition(b));
    expect(hashDefinition(a)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes with the base, setup, network, limits, and Dockerfile contents", () => {
    const base = compose({ t3: { image: "x" } });
    const hashes = new Set([
      hashDefinition(base),
      hashDefinition(compose({ t3: { image: "y" } })),
      hashDefinition(compose({ t3: { image: "x", setupCommand: "npm ci" } })),
      hashDefinition(compose({ t3: { image: "x", network: "restricted" } })),
      hashDefinition(compose({ t3: { image: "x", memory: "1g" } })),
    ]);
    expect(hashes.size).toBe(5);

    const dockerfile = compose({ t3: { dockerfile: "Dockerfile" } });
    if (dockerfile.base.kind !== "dockerfile") throw new Error("expected dockerfile base");
    const edited = { ...dockerfile, base: { ...dockerfile.base, dockerfileContent: "FROM x" } };
    expect(hashDefinition(edited)).not.toBe(hashDefinition(dockerfile));
  });
});
