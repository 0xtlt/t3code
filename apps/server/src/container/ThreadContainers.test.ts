// @effect-diagnostics nodeBuiltinImport:off -- a unique id for engine resource names.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ContainerError, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ProjectSecrets from "../secrets/ProjectSecrets.ts";
import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import { containerNames, environmentHash } from "./ContainerCommands.ts";
import * as ContainerEngine from "./ContainerEngine.ts";
import { derivedImageTag, ContainerLayerOptions } from "./DerivedImage.ts";
import * as ThreadContainers from "./ThreadContainers.ts";

describe("parseInspect", () => {
  const inspect = (entry: unknown) => ThreadContainers.parseInspect(JSON.stringify(entry));

  it("reads state, labels and image from docker's inspect JSON", () => {
    expect(
      inspect({
        State: { Running: true },
        Config: { Image: "t3code-env:abc", Labels: { "dev.t3code.thread": "t1", n: 1 } },
        ExecIDs: null,
      }),
    ).toEqual({
      running: true,
      labels: { "dev.t3code.thread": "t1" },
      image: "t3code-env:abc",
      busy: false,
    });
  });

  it("is busy while an exec is alive, and when the engine does not say", () => {
    expect(inspect({ State: { Running: true }, ExecIDs: ["abc"] })?.busy).toBe(true);
    expect(inspect({ State: { Running: true } })?.busy).toBe(true);
    expect(inspect({ State: { Running: true }, ExecIDs: [] })?.busy).toBe(false);
  });

  it("returns undefined for unreadable output", () => {
    expect(ThreadContainers.parseInspect("nope")).toBeUndefined();
    expect(ThreadContainers.parseInspect("null")).toBeUndefined();
  });

  it("accepts the array form podman prints", () => {
    expect(inspect([{ State: { Running: false }, Config: { Labels: null } }])?.running).toBe(false);
  });
});

// Needs a reachable container engine and pulls node:24-alpine on first use, so
// it is opt-in: T3_CONTAINER_INTEGRATION=1 vp test run <this file>.
describe.runIf(process.env["T3_CONTAINER_INTEGRATION"] === "1")("ThreadContainers (engine)", () => {
  const secretValues = { env: "env-secret-VALUE-7731", file: "file-secret-VALUE-4402" };
  const projectId = ProjectId.make("t3it-project");
  const base = { kind: "image", image: "node:24-alpine" } as const;

  const harness = (threadId: ThreadId, thread: { worktreePath: string }) => {
    const shell = {
      id: threadId,
      projectId,
      container: true,
      get worktreePath() {
        return thread.worktreePath;
      },
      archivedAt: null,
      providerInstanceId: "claudeAgent",
      providerInstanceHistory: [],
    };
    const projection = Layer.succeed(ProjectionStore.ProjectionStoreV2, {
      getThreadShell: (id: ThreadId) => Effect.succeed(id === threadId ? shell : null),
    } as unknown as ProjectionStore.ProjectionStoreV2["Service"]);
    const secrets = Layer.succeed(ProjectSecrets.ProjectSecrets, {
      resolveForThread: () =>
        Effect.succeed({
          fingerprint: "fp-1",
          secrets: [
            { name: "T3IT_ENV_SECRET", value: secretValues.env, exposeAs: "env" },
            { name: "T3IT_FILE_SECRET", value: secretValues.file, exposeAs: "file" },
          ],
        }),
      redact: (_id: ThreadId, text: string) => text,
    } as unknown as ProjectSecrets.ProjectSecrets["Service"]);
    return ThreadContainers.layer.pipe(
      Layer.provide(ContainerEngine.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          projection,
          secrets,
          // alpine has no npm and no apt; the layer then only prepares /t3home.
          Layer.succeed(ContainerLayerOptions, { toolchain: false }),
          T3ProjectFileLoader.layer,
          serverSettingsLayerTest(),
          ProcessRunner.layer,
        ),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-container-it-" })),
      Layer.provideMerge(NodeServices.layer),
    );
  };

  /**
   * A fresh git repository with a linked worktree holding `t3.json`, one
   * container thread over it, and a finalizer that removes everything the
   * scenario created in the engine.
   */
  const scenario = <A, E, R>(
    t3Container: Record<string, unknown>,
    body: (context: {
      readonly threadId: ThreadId;
      readonly worktree: string;
      readonly names: ReturnType<typeof containerNames>;
      readonly containers: ThreadContainers.ThreadContainers["Service"];
      readonly engine: (
        ...args: Array<string>
      ) => ReturnType<ProcessRunner.ProcessRunner["Service"]["run"]>;
      readonly exec: (
        script: string,
      ) => Effect.Effect<
        ProcessRunner.ProcessRunOutput,
        ContainerError | ProcessRunner.ProcessRunError
      >;
    }) => Effect.Effect<A, E, R>,
  ) => {
    const threadId = ThreadId.make(`t3it-${NodeCrypto.randomBytes(4).toString("hex")}`);
    const thread = { worktreePath: "" };
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      const containers = yield* ThreadContainers.ThreadContainers;
      const { stateDir } = yield* ServerConfig.ServerConfig;

      if (!(yield* containers.engineStatus).available) return;

      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-container-it-wt-" }),
      );
      const git = (cwd: string, ...args: Array<string>) =>
        runner.run({ command: "git", args, cwd, timeout: "30 seconds" });
      const repo = path.join(root, "repo");
      const worktree = path.join(root, "wt");
      yield* fileSystem.makeDirectory(repo);
      yield* git(repo, "init", "-q", "-b", "main");
      yield* git(
        repo,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
      );
      yield* git(repo, "worktree", "add", "-q", worktree);
      yield* fileSystem.writeFileString(
        path.join(worktree, "t3.json"),
        JSON.stringify({ container: t3Container }),
      );
      thread.worktreePath = worktree;

      const names = containerNames(environmentHash(stateDir), threadId);
      const engine = (...args: Array<string>) =>
        runner.run({ command: "docker", args, timeout: "60 seconds" });
      const imageTag = derivedImageTag(base, { toolchain: false });
      const imageExisted = (yield* engine("image", "inspect", imageTag)).code === 0;

      const exec = (script: string) =>
        Effect.gen(function* () {
          const wrapped = yield* containers.wrapExec({
            threadId,
            command: "/bin/sh",
            args: ["-c", script],
            env: { T3IT_ENV_SECRET: secretValues.env, PATH: "/usr/bin" },
            tty: false,
          });
          const argv = wrapped.args.join("\n");
          expect(argv).not.toContain(secretValues.env);
          expect(argv).not.toContain(secretValues.file);
          return yield* runner.run({
            command: wrapped.command,
            args: [...wrapped.args],
            env: { ...process.env, T3IT_ENV_SECRET: secretValues.env },
            timeout: "30 seconds",
          });
        });

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* containers.remove(threadId, { purge: true });
          if (!imageExisted) yield* engine("image", "rm", imageTag).pipe(Effect.ignore);
        }),
      );

      return yield* body({ threadId, worktree, names, containers, engine, exec });
    }).pipe(Effect.scoped, Effect.provide(harness(threadId, thread)));
  };

  it.live(
    "creates, runs, stops and removes a container thread",
    () =>
      scenario(
        { image: "node:24-alpine", setupCommand: "echo ready > setup.txt" },
        ({ threadId, worktree, names, containers, engine, exec }) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;

            const ensured = yield* containers.ensure(threadId);
            expect(ensured.state).toBe("running");
            expect(ensured.containerName).toBe(names.container);

            const result = yield* exec(
              'id -u > created-by.txt; id -g >> created-by.txt; echo "env=$T3IT_ENV_SECRET"; ' +
                'echo "file=$(cat /run/secrets/T3IT_FILE_SECRET)"; echo "home=$HOME"; pwd; ' +
                "if (echo x >> /run/secrets/T3IT_FILE_SECRET) 2>/dev/null; then echo writable; else echo readonly; fi; " +
                "cat setup.txt; test -d \"$(sed 's/^gitdir: //' .git)\" && echo gitdir-mounted",
            );
            expect(result.code).toBe(0);
            const lines = result.stdout.split("\n").map((line) => line.trim());
            expect(lines).toContain(`env=${secretValues.env}`);
            expect(lines).toContain(`file=${secretValues.file}`);
            expect(lines).toContain("home=/t3home");
            expect(lines).toContain(worktree);
            expect(lines).toContain("readonly");
            expect(lines).toContain("ready");
            expect(lines).toContain("gitdir-mounted");

            const created = yield* fileSystem.stat(path.join(worktree, "created-by.txt"));
            expect(created.uid._tag === "Some" ? created.uid.value : undefined).toBe(
              process.getuid?.(),
            );

            // A second ensure is the cheap fast path and keeps the same container.
            expect((yield* containers.ensure(threadId)).state).toBe("running");
            expect((yield* containers.status(threadId)).stale).toBeUndefined();

            expect((yield* containers.stop(threadId)).state).toBe("stopped");

            // A stopped container comes back on demand, with its file secrets rewritten.
            const again = yield* exec("cat /run/secrets/T3IT_FILE_SECRET");
            expect(again.stdout.trim()).toBe(secretValues.file);

            yield* containers.remove(threadId, { purge: true });
            const leftover = yield* engine(
              "ps",
              "-a",
              "--filter",
              `name=${names.container}`,
              "--format",
              "{{.Names}}",
            );
            expect(leftover.stdout.trim()).toBe("");
            const volumes = yield* engine("volume", "ls", "-q", "--filter", `name=${names.volume}`);
            expect(volumes.stdout.trim()).toBe("");
            expect((yield* containers.status(threadId)).state).toBe("absent");
          }),
      ),
    { timeout: 120_000 },
  );

  it.live(
    "restricted network: only allowed hosts are reachable, through the egress proxy",
    () =>
      scenario(
        { image: "node:24-alpine", network: "restricted", allowedHosts: [] },
        ({ threadId, names, containers, engine, exec }) =>
          Effect.gen(function* () {
            // host.docker.internal is on the allowlist, so a server on the host answers.
            const server = yield* Effect.acquireRelease(
              Effect.promise(
                () =>
                  new Promise<NodeHttp.Server>((resolve) => {
                    const listening = NodeHttp.createServer((_req, res) => res.end("from-host"));
                    listening.listen(0, "127.0.0.1", () => resolve(listening));
                  }),
              ),
              (listening) => Effect.sync(() => listening.close()),
            );
            const address = server.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;

            expect((yield* containers.ensure(threadId)).state).toBe("running");
            const proxy = yield* engine(
              "ps",
              "--filter",
              `name=${names.proxy}`,
              "--format",
              "{{.Names}}",
            );
            expect(proxy.stdout.trim()).toBe(names.proxy);

            const allowed = yield* exec(`wget -q -T 10 -O- http://host.docker.internal:${port}/`);
            expect(allowed.stdout).toBe("from-host");

            // Not on the allowlist: the proxy answers 403 for plain HTTP and CONNECT.
            const denied = yield* exec("wget -S -T 10 -O- http://example.invalid/ 2>&1; true");
            expect(denied.stdout).toContain("403");
            const tunnel = yield* exec("wget -S -T 10 -O- https://example.invalid/ 2>&1; true");
            expect(tunnel.stdout).toMatch(/403|Forbidden|error getting response/i);

            // Ignoring the proxy settings fails closed: the network has no route out.
            const direct = yield* exec(
              "env -u http_proxy -u HTTP_PROXY wget -q -T 4 -O- http://1.1.1.1/ >/dev/null 2>&1; echo exit=$?",
            );
            expect(direct.stdout.trim()).not.toBe("exit=0");

            yield* containers.remove(threadId, { purge: true });
            const network = yield* engine(
              "network",
              "ls",
              "-q",
              "--filter",
              `name=${names.network}`,
            );
            expect(network.stdout.trim()).toBe("");
            const sidecar = yield* engine(
              "ps",
              "-a",
              "--filter",
              `name=${names.proxy}`,
              "--format",
              "{{.Names}}",
            );
            expect(sidecar.stdout.trim()).toBe("");
          }),
      ),
    { timeout: 120_000 },
  );
});
