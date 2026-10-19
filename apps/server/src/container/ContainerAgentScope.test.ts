// @effect-diagnostics nodeBuiltinImport:off -- the credential files live in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ContainerAgentScope from "./ContainerAgentScope.ts";
import { containerLaunchFor } from "./ContainerAgentScope.ts";
import { makeFakeThreadContainers } from "./ThreadContainers.testkit.ts";

const hostScope = Layer.succeed(AgentScope, {
  wrap: ({ command, args }) => Effect.succeed({ command: `host:${command}`, args }),
  oomKilled: () => Effect.succeed(true),
  inContainer: () => Effect.succeed(false),
  clear: () => Effect.void,
});

const scopeOver = (fake: ReturnType<typeof makeFakeThreadContainers>, home = "/nonexistent-home") =>
  ContainerAgentScope.layer.pipe(
    Layer.provide(hostScope),
    Layer.provide(ContainerAgentScope.layerBind.pipe(Layer.provide(fake.layer))),
    Layer.provide(ContainerAgentScope.layerLink),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
  );

describe("ContainerAgentScope", () => {
  it.effect(
    "routes container threads into the container and leaves other threads on the host",
    () => {
      const fake = makeFakeThreadContainers({ containerThreads: ["thread-c"] });
      return Effect.gen(function* () {
        const scope = yield* AgentScope;
        const inside = yield* scope.wrap({
          command: "/opt/claude/bin/claude",
          args: ["--print"],
          name: "claude",
          threadId: "thread-c",
        });
        expect(inside).toEqual({
          command: "docker",
          args: ["exec", "t3-container", "claude", "--print"],
        });
        expect(fake.ensured).toEqual(["thread-c"]);
        expect(fake.wrapped[0]).toMatchObject({
          threadId: "thread-c",
          command: "claude",
          tty: false,
        });

        const onHost = yield* scope.wrap({
          command: "claude",
          args: [],
          name: "claude",
          threadId: "thread-h",
        });
        expect(onHost.command).toBe("host:claude");
        const noThread = yield* scope.wrap({ command: "zsh", args: [], name: "terminal" });
        expect(noThread.command).toBe("host:zsh");
        expect(fake.wrapped).toHaveLength(1);

        expect(yield* scope.inContainer("thread-c")).toBe(true);
        expect(yield* scope.inContainer("thread-h")).toBe(false);
        expect(yield* scope.oomKilled("thread-c")).toBe(true);
      }).pipe(Effect.provide(scopeOver(fake)));
    },
  );

  it.effect(
    "runs a terminal shell that prefers bash on a TTY and forwards terminal settings",
    () => {
      const fake = makeFakeThreadContainers({ containerThreads: ["thread-c"] });
      return Effect.gen(function* () {
        const scope = yield* AgentScope;
        yield* scope.wrap({
          command: "/usr/bin/zsh",
          args: ["-l"],
          name: "terminal",
          threadId: "thread-c",
          env: { TERM: "xterm-256color" },
        });
        const call = fake.wrapped[0]!;
        expect(call.tty).toBe(true);
        expect(call.command).toBe("/bin/sh");
        expect(call.args).toEqual([
          "-c",
          "command -v bash >/dev/null 2>&1 && exec bash -i || exec sh -i",
        ]);
        expect(call.forwardEnv).toEqual(expect.arrayContaining(["TERM", "COLORTERM", "LANG"]));
      }).pipe(Effect.provide(scopeOver(fake)));
    },
  );

  it.effect("turns a container failure into a failing command, never a host launch", () => {
    const failures = [
      makeFakeThreadContainers({ containerThreads: ["t"], ensureError: "Docker is not running" }),
      makeFakeThreadContainers({ containerThreads: ["t"], wrapError: "Docker is not running" }),
    ];
    return Effect.forEach(failures, (fake) =>
      Effect.gen(function* () {
        const scope = yield* AgentScope;
        const launch = yield* scope.wrap({
          command: "claude",
          args: [],
          name: "claude",
          threadId: "t",
        });
        expect(launch.command).toBe("/bin/sh");
        expect(launch.args.at(-1)).toBe("Container unavailable: Docker is not running");
        expect(launch.args.join(" ")).toContain("exit 1");
      }).pipe(Effect.provide(scopeOver(fake))),
    );
  });

  it.effect("refuses a provider it cannot run in a container instead of using the host", () => {
    const fake = makeFakeThreadContainers({ containerThreads: ["t"] });
    return Effect.gen(function* () {
      const scope = yield* AgentScope;
      const launch = yield* scope.wrap({ command: "grok", args: [], name: "grok", threadId: "t" });
      expect(launch.command).toBe("/bin/sh");
      expect(launch.args.at(-1)).toContain("can't run in a container thread");
      expect(fake.wrapped).toHaveLength(0);
    }).pipe(Effect.provide(scopeOver(fake)));
  });

  it.effect("copies provider credential files into the container once per thread", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-container-scope-"));
    NodeFS.mkdirSync(NodePath.join(home, ".codex"));
    NodeFS.mkdirSync(NodePath.join(home, ".claude"));
    NodeFS.writeFileSync(NodePath.join(home, ".codex", "auth.json"), "{}");
    NodeFS.writeFileSync(NodePath.join(home, ".claude", ".credentials.json"), "{}");
    const fake = makeFakeThreadContainers({ containerThreads: ["t"] });
    return Effect.gen(function* () {
      const scope = yield* AgentScope;
      const codex = {
        command: "codex",
        args: ["app-server"],
        name: "codex",
        threadId: "t",
        env: { CODEX_HOME: NodePath.join(home, ".codex") },
      };
      yield* scope.wrap(codex);
      yield* scope.wrap(codex);
      yield* scope.wrap({ command: "claude", args: [], name: "claude", threadId: "t" });
      yield* scope.wrap({ command: "zsh", args: [], name: "terminal", threadId: "t" });
      expect(fake.copied).toEqual([
        {
          threadId: "t",
          hostPath: NodePath.join(home, ".codex", "auth.json"),
          containerPath: "/t3home/.codex/auth.json",
        },
        {
          threadId: "t",
          hostPath: NodePath.join(home, ".claude", ".credentials.json"),
          containerPath: "/t3home/.claude/.credentials.json",
        },
      ]);
    }).pipe(
      Effect.provide(scopeOver(fake, home)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
    );
  });
});

describe("containerLaunchFor", () => {
  it("launches Claude as `claude` with provider auth names and no host paths", () => {
    const launch = containerLaunchFor({
      name: "claude",
      command: "/Users/me/.local/bin/claude",
      args: ["--x"],
      env: { CLAUDE_CONFIG_DIR: "/Users/me/.claude" },
    })!;
    expect(launch.command).toBe("claude");
    expect(launch.args).toEqual(["--x"]);
    expect(launch.tty).toBe(false);
    expect(launch.forwardEnv).toEqual(
      expect.arrayContaining([
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "AWS_REGION",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_AGENT_SDK_VERSION",
      ]),
    );
    expect(launch.forwardEnv).not.toContain("CLAUDE_CONFIG_DIR");
  });

  it("points Codex at the container's own CODEX_HOME and forwards only non-path CODEX_ variables", () => {
    const launch = containerLaunchFor({
      name: "codex",
      command: "/opt/homebrew/bin/codex",
      args: ["app-server"],
      env: {
        CODEX_HOME: "/Users/me/.codex",
        CODEX_SQLITE_HOME: "/Users/me/.codex/sqlite",
        CODEX_LOG: "debug",
        PATH: "/bin",
      },
    })!;
    expect(launch.command).toBe("/opt/homebrew/bin/codex");
    expect(launch.setEnv).toEqual({ CODEX_HOME: "/t3home/.codex" });
    expect(launch.forwardEnv).toEqual(
      expect.arrayContaining(["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_LOG"]),
    );
    expect(launch.forwardEnv).not.toContain("CODEX_HOME");
    expect(launch.forwardEnv).not.toContain("CODEX_SQLITE_HOME");
    expect(launch.forwardEnv).not.toContain("PATH");
  });

  it("has no launch for an unknown process", () => {
    expect(containerLaunchFor({ name: "grok", command: "grok", args: [] })).toBeUndefined();
  });
});
