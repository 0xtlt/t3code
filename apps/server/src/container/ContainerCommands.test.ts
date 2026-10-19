import { describe, expect, it } from "@effect/vitest";

import {
  baseLabels,
  buildBaseImageBuildArgs,
  buildDerivedImageBuildArgs,
  buildExecArgs,
  buildProxyRunArgs,
  buildRunArgs,
  containerNames,
  environmentHash,
  isHostSpecificEnvName,
  proxyEnv,
  restrictedAllowedHosts,
  selectForwardedEnv,
  threadNameSegment,
  unsafeMountPath,
} from "./ContainerCommands.ts";

const names = containerNames("abcd1234", "thread-1");
const labels = baseLabels("abcd1234", "thread-1");

const runInput = {
  names,
  image: "t3code-env:0123456789abcdef",
  labels,
  worktreePath: "/work/wt",
  gitCommonDir: "/work/repo/.git",
  user: { uid: 501, gid: 20 },
  addHostGateway: false,
  cpus: null,
  memory: null,
  network: undefined,
  env: {},
  secretEnvNames: [],
} as const;

describe("naming and labels", () => {
  it("names the container, proxy, network and home volume from the environment and thread", () => {
    expect(names).toEqual({
      container: "t3code-abcd1234-thread-1",
      proxy: "t3code-abcd1234-thread-1-proxy",
      network: "t3code-net-abcd1234-thread-1",
      volume: "t3code-home-abcd1234-thread-1",
    });
  });

  it("derives a stable 8 character environment hash from the state directory", () => {
    expect(environmentHash("/home/a/.t3/userdata")).toMatch(/^[0-9a-f]{8}$/);
    expect(environmentHash("/home/a/.t3/userdata")).toBe(environmentHash("/home/a/.t3/userdata"));
    expect(environmentHash("/home/a/.t3/userdata")).not.toBe(
      environmentHash("/home/b/.t3/userdata"),
    );
  });

  it("keeps fitting thread ids readable and never collapses two unsafe ids into one name", () => {
    expect(threadNameSegment("0f9c-77_a.b")).toBe("0f9c-77_a.b");
    const a = threadNameSegment("thread/with spaces");
    const b = threadNameSegment("thread/with-spaces");
    expect(a).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
    expect(a).not.toBe(b);
    expect(threadNameSegment("x".repeat(200)).length).toBeLessThanOrEqual(41);
  });

  it("labels carry the environment and thread", () => {
    expect(labels).toEqual({
      "dev.t3code.environment": "abcd1234",
      "dev.t3code.thread": "thread-1",
    });
  });
});

describe("buildRunArgs", () => {
  const args = buildRunArgs(runInput);
  const pair = (flag: string, value: string) =>
    args.some((arg, index) => arg === flag && args[index + 1] === value);

  it("creates a detached, init'd, sandboxed container with the documented environment", () => {
    expect(args.slice(0, 5)).toEqual(["run", "-d", "--init", "--name", names.container]);
    for (const entry of [
      "HOME=/t3home",
      "IS_SANDBOX=1",
      "GIT_CONFIG_COUNT=1",
      "GIT_CONFIG_KEY_0=safe.directory",
      "GIT_CONFIG_VALUE_0=*",
    ]) {
      expect(pair("-e", entry)).toBe(true);
    }
    expect(pair("-v", `${names.volume}:/t3home`)).toBe(true);
    expect(pair("-w", "/work/wt")).toBe(true);
    expect(pair("--tmpfs", "/run/secrets:mode=0755")).toBe(true);
    expect(pair("--pids-limit", "4096")).toBe(true);
    expect(pair("--user", "501:20")).toBe(true);
    expect(pair("--entrypoint", "/bin/sh")).toBe(true);
  });

  it("mounts the worktree and the git common dir at their host paths", () => {
    expect(pair("--mount", "type=bind,source=/work/wt,target=/work/wt")).toBe(true);
    expect(pair("--mount", "type=bind,source=/work/repo/.git,target=/work/repo/.git")).toBe(true);
  });

  it("does not mount a git dir that already lives inside the worktree", () => {
    const inside = buildRunArgs({ ...runInput, gitCommonDir: "/work/wt/.git" });
    expect(inside.filter((arg) => arg === "--mount")).toHaveLength(1);
  });

  it("ends with the image and a sleep-forever command that exits on TERM", () => {
    const tail = args.slice(-3);
    expect(tail[0]).toBe(runInput.image);
    expect(tail[1]).toBe("-c");
    expect(tail[2]).toContain("trap 'exit 0' TERM");
  });

  it("omits optional flags by default and adds them when configured", () => {
    for (const flag of ["--cpus", "--memory", "--network", "--add-host"]) {
      expect(args).not.toContain(flag);
    }
    const configured = buildRunArgs({
      ...runInput,
      cpus: 2,
      memory: "4g",
      network: "internal-net",
      addHostGateway: true,
      user: undefined,
    });
    expect(configured).toEqual(expect.arrayContaining(["--cpus", "2", "--memory", "4g"]));
    expect(configured).toEqual(expect.arrayContaining(["--network", "internal-net"]));
    expect(configured).toEqual(
      expect.arrayContaining(["--add-host", "host.docker.internal:host-gateway"]),
    );
    expect(configured).not.toContain("--user");
  });

  it("passes secret env by name only", () => {
    const secretValue = "s3cr3t-VALUE-9f2";
    const withSecret = buildRunArgs({ ...runInput, secretEnvNames: ["API_TOKEN"] });
    expect(withSecret).toEqual(expect.arrayContaining(["-e", "API_TOKEN"]));
    expect(withSecret.join("\n")).not.toContain(secretValue);
    expect(withSecret.some((arg) => arg.startsWith("API_TOKEN="))).toBe(false);
  });

  it("labels the container", () => {
    expect(pair("--label", "dev.t3code.thread=thread-1")).toBe(true);
  });
});

describe("buildExecArgs", () => {
  const base = {
    container: names.container,
    worktreePath: "/work/wt",
    command: "/usr/local/bin/claude",
    args: ["--print", "hi"],
    tty: false,
    forwardedNames: ["ANTHROPIC_API_KEY"],
    setEnv: { CODEX_HOME: "/t3home/.codex" },
  } as const;

  it("runs the command's basename from the worktree with names-only env forwarding", () => {
    expect(buildExecArgs(base)).toEqual([
      "exec",
      "-i",
      "-w",
      "/work/wt",
      "-e",
      "ANTHROPIC_API_KEY",
      "-e",
      "CODEX_HOME=/t3home/.codex",
      names.container,
      "claude",
      "--print",
      "hi",
    ]);
  });

  it("allocates a tty and a user only when asked", () => {
    const tty = buildExecArgs({ ...base, tty: true, user: "0" });
    expect(tty.slice(0, 5)).toEqual(["exec", "-i", "-t", "-u", "0"]);
    expect(buildExecArgs(base)).not.toContain("-t");
  });

  it("handles Windows host paths for the command", () => {
    expect(buildExecArgs({ ...base, command: "C:\\bin\\claude.exe" })).toContain("claude.exe");
  });
});

describe("image builds", () => {
  it("builds the derived image from stdin so nothing is written to the worktree", () => {
    const args = buildDerivedImageBuildArgs({
      kind: "docker",
      tag: "t3code-env:x",
      refresh: false,
    });
    expect(args.at(-1)).toBe("-");
    expect(args).toContain("--progress=plain");
    expect(args).not.toContain("--no-cache");
  });

  it("refreshes with a pull and no cache, and podman skips --progress", () => {
    const args = buildDerivedImageBuildArgs({ kind: "podman", tag: "t3code-env:x", refresh: true });
    expect(args).toEqual(expect.arrayContaining(["--pull", "--no-cache"]));
    expect(args).not.toContain("--progress=plain");
  });

  it("passes build args as separate argv entries", () => {
    const args = buildBaseImageBuildArgs({
      kind: "docker",
      tag: "t3code-base:x",
      dockerfile: "/work/wt/Dockerfile",
      context: "/work/wt",
      buildArgs: { NODE: "24; rm -rf /" },
      refresh: false,
    });
    expect(args).toEqual(expect.arrayContaining(["--build-arg", "NODE=24; rm -rf /"]));
    expect(args.slice(-1)).toEqual(["/work/wt"]);
  });
});

describe("restricted network", () => {
  it("allows provider hosts, configured hosts and the T3 server", () => {
    const hosts = restrictedAllowedHosts({
      providerInstanceIds: ["claudeAgent"],
      allowedHosts: ["registry.npmjs.org", "*.github.com"],
    });
    expect(hosts).toEqual(
      expect.arrayContaining([
        "api.anthropic.com",
        "statsig.anthropic.com",
        "claude.ai",
        "console.anthropic.com",
        "platform.claude.com",
        "sentry.io",
        "registry.npmjs.org",
        "*.github.com",
        "host.docker.internal",
      ]),
    );
    expect(hosts).not.toContain("api.openai.com");
  });

  it("adds codex hosts for codex instances, and both lists for an unrecognizable id", () => {
    const codex = restrictedAllowedHosts({ providerInstanceIds: ["codex"], allowedHosts: [] });
    expect(codex).toEqual(
      expect.arrayContaining([
        "api.openai.com",
        "chatgpt.com",
        "auth.openai.com",
        "ab.chatgpt.com",
      ]),
    );
    expect(codex).not.toContain("api.anthropic.com");
    const custom = restrictedAllowedHosts({ providerInstanceIds: ["my-agent"], allowedHosts: [] });
    expect(custom).toEqual(expect.arrayContaining(["api.openai.com", "api.anthropic.com"]));
  });

  it("points the agent at the proxy and keeps loopback direct", () => {
    const env = proxyEnv(names.proxy);
    expect(env["HTTPS_PROXY"]).toBe(`http://${names.proxy}:3128`);
    expect(env["http_proxy"]).toBe(env["HTTP_PROXY"]);
    expect(env["NO_PROXY"]).toBe("localhost,127.0.0.1");
  });

  it("starts the proxy on the bridge with the allowlist in its environment", () => {
    const args = buildProxyRunArgs({
      names,
      labels,
      bridge: "bridge",
      allowedHosts: ["a.example", "*.b.example"],
      addHostGateway: true,
    });
    expect(args).toEqual(expect.arrayContaining(["--network", "bridge"]));
    expect(args).toContain("T3_PROXY_ALLOW=a.example,*.b.example");
    expect(args).toEqual(
      expect.arrayContaining(["--add-host", "host.docker.internal:host-gateway"]),
    );
    expect(args).toContain("node:24-alpine");
  });
});

describe("unsafeMountPath", () => {
  it("accepts plain absolute paths, including colons and spaces", () => {
    expect(unsafeMountPath("/Users/a/My Repo:v2")).toBe(false);
  });

  it("rejects relative paths and CSV-breaking characters", () => {
    expect(unsafeMountPath("relative/path")).toBe(true);
    expect(unsafeMountPath("/work/a,b")).toBe(true);
    expect(unsafeMountPath('/work/a"b')).toBe(true);
  });
});

describe("env forwarding", () => {
  const home = "/Users/dev";
  const worktreePath = "/Users/dev/wt";
  const hostEnv = { ANTHROPIC_API_KEY: "host-key", PATH: "/usr/bin", FOO: "bar", LANG: "en_US" };
  const select = (env: NodeJS.ProcessEnv, forwardEnv: ReadonlyArray<string> = []) =>
    selectForwardedEnv({ env, hostEnv, forwardEnv, homeDirectory: home, worktreePath });

  it("never forwards host-specific names, even when allowlisted", () => {
    for (const name of [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "SHELL",
      "TMPDIR",
      "TMP",
      "TEMP",
      "PWD",
      "OLDPWD",
      "SHLVL",
      "XDG_CONFIG_HOME",
      "TERM_PROGRAM",
      "TERM_PROGRAM_VERSION",
      "DISPLAY",
      "SSH_AUTH_SOCK",
      "CODEX_HOME",
      "CLAUDE_CONFIG_DIR",
      "NODE_OPTIONS",
      "ELECTRON_RUN_AS_NODE",
      "DOCKER_HOST",
      "T3CODE_HOME",
      "__CFBundleIdentifier",
    ]) {
      expect(isHostSpecificEnvName(name), name).toBe(true);
      expect(select({ [name]: "changed" }, [name]), name).toEqual([]);
    }
    expect(isHostSpecificEnvName("ANTHROPIC_API_KEY")).toBe(false);
  });

  it("forwards allowlisted names that are present, and ignores inherited server variables", () => {
    expect(select(hostEnv, ["ANTHROPIC_API_KEY"])).toEqual(["ANTHROPIC_API_KEY"]);
    expect(select(hostEnv)).toEqual([]);
  });

  it("forwards a variable the caller set to a value that differs from the server's own", () => {
    expect(select({ ...hostEnv, OPENAI_API_KEY: "k", FOO: "changed" })).toEqual([
      "FOO",
      "OPENAI_API_KEY",
    ]);
  });

  it("drops absolute host-home paths unless they point into the worktree", () => {
    expect(select({ MY_CACHE: "/Users/dev/.cache/x" }, ["MY_CACHE"])).toEqual([]);
    expect(select({ MY_DIR: "/Users/dev/wt/out" }, ["MY_DIR"])).toEqual(["MY_DIR"]);
    expect(select({ SOME_PATH: "/opt/tools" }, ["SOME_PATH"])).toEqual(["SOME_PATH"]);
  });

  it("skips names the engine CLI could not take and unset values", () => {
    expect(select({ "BAD NAME": "x", EMPTY: undefined }, ["BAD NAME", "EMPTY"])).toEqual([]);
  });

  it("returns names only, sorted", () => {
    const forwarded = select({ B_KEY: "2", A_KEY: "1" }, ["B_KEY", "A_KEY"]);
    expect(forwarded).toEqual(["A_KEY", "B_KEY"]);
  });
});
