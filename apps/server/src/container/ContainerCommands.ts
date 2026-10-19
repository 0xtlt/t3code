// @effect-diagnostics nodeBuiltinImport:off -- pure path math on host paths.
import * as NodePath from "node:path";

import type { ContainerEngineKind } from "@t3tools/contracts";

import { sha256Hex } from "./ContainerDefinition.ts";
import { HOME_DIRECTORY } from "./DerivedImage.ts";
import { EGRESS_PROXY_IMAGE, EGRESS_PROXY_PORT, EGRESS_PROXY_SOURCE } from "./EgressProxy.ts";

export const LABEL_ENVIRONMENT = "dev.t3code.environment";
export const LABEL_THREAD = "dev.t3code.thread";
export const LABEL_DEFINITION = "dev.t3code.definition";
export const LABEL_SECRETS = "dev.t3code.secrets";
export const LABEL_ROLE = "dev.t3code.role";

export const SECRETS_DIRECTORY = "/run/secrets";
export const HOST_ALIAS = "host.docker.internal";

/** Distinguishes this server's containers from other T3 Code installs sharing the engine. */
export const environmentHash = (stateDir: string): string => sha256Hex(stateDir).slice(0, 8);

/**
 * Thread ids are opaque; a name must be [A-Za-z0-9_.-] and bounded. Ids that
 * already fit are used as is so names stay readable; others get a hash suffix
 * so two ids never collapse into one name.
 */
export function threadNameSegment(threadId: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/.test(threadId)) return threadId;
  const readable = threadId.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  return `${readable.slice(0, 32)}-${sha256Hex(threadId).slice(0, 8)}`;
}

export interface ContainerNames {
  readonly container: string;
  readonly proxy: string;
  readonly network: string;
  readonly volume: string;
}

export function containerNames(envHash: string, threadId: string): ContainerNames {
  const segment = threadNameSegment(threadId);
  return {
    container: `t3code-${envHash}-${segment}`,
    proxy: `t3code-${envHash}-${segment}-proxy`,
    network: `t3code-net-${envHash}-${segment}`,
    volume: `t3code-home-${envHash}-${segment}`,
  };
}

export const baseLabels = (envHash: string, threadId: string) => ({
  [LABEL_ENVIRONMENT]: envHash,
  [LABEL_THREAD]: threadId,
});

export function labelArgs(labels: Readonly<Record<string, string>>): Array<string> {
  return Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

/** Sleeps until told to stop; `--init` reaps whatever the agent leaves behind. */
export const IDLE_COMMAND = "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done";

export interface HostUser {
  readonly uid: number;
  readonly gid: number;
}

export function currentHostUser(platform: NodeJS.Platform): HostUser | undefined {
  if (platform === "win32" || typeof process.getuid !== "function") return undefined;
  return { uid: process.getuid(), gid: process.getgid?.() ?? process.getuid() };
}

/** The engine's pre-defined bridge network, which the proxy sidecar attaches to. */
export const defaultBridgeNetwork = (kind: ContainerEngineKind) =>
  kind === "podman" ? "podman" : "bridge";

const bindMount = (path: string) => `type=bind,source=${path},target=${path}`;

/**
 * Bind mounts are `--mount` rather than `-v` so a path containing `:` cannot
 * be misread as a mode. Commas and quotes are CSV syntax in `--mount`, so such
 * paths are rejected up front.
 */
export function unsafeMountPath(path: string): boolean {
  return !NodePath.posix.isAbsolute(path) || /[,"\n\r]/.test(path);
}

export interface RunInput {
  readonly names: ContainerNames;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly worktreePath: string;
  readonly gitCommonDir: string | undefined;
  readonly user: HostUser | undefined;
  readonly addHostGateway: boolean;
  readonly cpus: number | null;
  readonly memory: string | null;
  /** The internal network of a restricted thread; undefined uses the default bridge. */
  readonly network: string | undefined;
  /** Literal, non-secret values. */
  readonly env: Readonly<Record<string, string>>;
  /** Names only: the values travel in the spawned CLI's environment. */
  readonly secretEnvNames: ReadonlyArray<string>;
}

export function buildRunArgs(input: RunInput): Array<string> {
  const { worktreePath, gitCommonDir } = input;
  const literalEnv: Record<string, string> = {
    ...input.env,
    HOME: HOME_DIRECTORY,
    IS_SANDBOX: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
  };
  const mountsGitDir =
    gitCommonDir !== undefined && NodePath.relative(worktreePath, gitCommonDir).startsWith("..");
  return [
    "run",
    "-d",
    "--init",
    "--name",
    input.names.container,
    ...labelArgs(input.labels),
    ...Object.entries(literalEnv).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    ...input.secretEnvNames.flatMap((name) => ["-e", name]),
    "-v",
    `${input.names.volume}:${HOME_DIRECTORY}`,
    "--mount",
    bindMount(worktreePath),
    ...(mountsGitDir ? ["--mount", bindMount(gitCommonDir)] : []),
    "-w",
    worktreePath,
    "--tmpfs",
    `${SECRETS_DIRECTORY}:mode=0755`,
    ...(input.cpus === null ? [] : ["--cpus", String(input.cpus)]),
    ...(input.memory === null ? [] : ["--memory", input.memory]),
    "--pids-limit",
    "4096",
    ...(input.user === undefined ? [] : ["--user", `${input.user.uid}:${input.user.gid}`]),
    ...(input.network === undefined ? [] : ["--network", input.network]),
    ...(input.addHostGateway ? ["--add-host", `${HOST_ALIAS}:host-gateway`] : []),
    "--entrypoint",
    "/bin/sh",
    input.image,
    "-c",
    IDLE_COMMAND,
  ];
}

export function proxyEnv(proxyHost: string): Record<string, string> {
  const url = `http://${proxyHost}:${EGRESS_PROXY_PORT}`;
  const noProxy = "localhost,127.0.0.1";
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

export function buildProxyRunArgs(input: {
  readonly names: ContainerNames;
  readonly labels: Readonly<Record<string, string>>;
  readonly bridge: string;
  readonly allowedHosts: ReadonlyArray<string>;
  readonly addHostGateway: boolean;
}): Array<string> {
  return [
    "run",
    "-d",
    "--init",
    "--name",
    input.names.proxy,
    ...labelArgs(input.labels),
    "--network",
    input.bridge,
    "--pids-limit",
    "256",
    "--memory",
    "128m",
    ...(input.addHostGateway ? ["--add-host", `${HOST_ALIAS}:host-gateway`] : []),
    "-e",
    `T3_PROXY_ALLOW=${input.allowedHosts.join(",")}`,
    "-e",
    `T3_PROXY_PORT=${EGRESS_PROXY_PORT}`,
    "--entrypoint",
    "node",
    EGRESS_PROXY_IMAGE,
    "-e",
    EGRESS_PROXY_SOURCE,
  ];
}

export function buildBaseImageBuildArgs(input: {
  readonly kind: ContainerEngineKind;
  readonly tag: string;
  readonly dockerfile: string;
  readonly context: string;
  readonly buildArgs: Readonly<Record<string, string>>;
  readonly refresh: boolean;
}): Array<string> {
  return [
    "build",
    "-t",
    input.tag,
    ...(input.kind === "docker" ? ["--progress=plain"] : []),
    ...(input.refresh ? ["--pull", "--no-cache"] : []),
    "-f",
    input.dockerfile,
    ...Object.entries(input.buildArgs).flatMap(([key, value]) => [
      "--build-arg",
      `${key}=${value}`,
    ]),
    input.context,
  ];
}

/** The Dockerfile arrives on stdin (`-`), so nothing is written into the worktree. */
export function buildDerivedImageBuildArgs(input: {
  readonly kind: ContainerEngineKind;
  readonly tag: string;
  readonly refresh: boolean;
}): Array<string> {
  return [
    "build",
    "-t",
    input.tag,
    ...(input.kind === "docker" ? ["--progress=plain"] : []),
    ...(input.refresh ? ["--pull", "--no-cache"] : []),
    "-",
  ];
}

// Host-specific variables that mean nothing, or something harmful, inside the
// container. Prefix entries end with `*`.
const HOST_SPECIFIC_ENV = [
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
  "XDG_*",
  "TERM_PROGRAM*",
  "DISPLAY",
  "SSH_AUTH_SOCK",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "NODE_OPTIONS",
  "ELECTRON_*",
  "DOCKER_*",
  "T3CODE_*",
  "__CF*",
] as const;

export function isHostSpecificEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return HOST_SPECIFIC_ENV.some((entry) =>
    entry.endsWith("*") ? upper.startsWith(entry.slice(0, -1)) : upper === entry,
  );
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names to forward as `-e NAME`. A variable crosses when it is allowlisted
 * (`forwardEnv`) and present, or when the caller set it in `env` to something
 * other than the server's own value, which marks it as put there for the
 * agent (an API key from settings, an MCP URL). Inherited server variables
 * otherwise stay behind. Never forwarded, whatever the source: the
 * host-specific names above, and values that are absolute paths into the
 * user's home outside the worktree. Those paths do not exist in the container,
 * and forwarding one would also tell the agent where its host files live.
 */
export function selectForwardedEnv(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly hostEnv: NodeJS.ProcessEnv;
  readonly forwardEnv: ReadonlyArray<string>;
  readonly homeDirectory: string;
  readonly worktreePath: string;
}): Array<string> {
  const allowlisted = new Set(input.forwardEnv);
  const home = input.homeDirectory.replace(/\/+$/, "");
  const underHome = (value: string) => value === home || value.startsWith(`${home}/`);
  const underWorktree = (value: string) =>
    value === input.worktreePath || value.startsWith(`${input.worktreePath}/`);
  return Object.entries(input.env)
    .filter(([name, value]) => {
      if (value === undefined || !ENV_NAME.test(name) || isHostSpecificEnvName(name)) return false;
      if (home.length > 1 && underHome(value) && !underWorktree(value)) return false;
      return allowlisted.has(name) || input.hostEnv[name] !== value;
    })
    .map(([name]) => name)
    .toSorted();
}

export function buildExecArgs(input: {
  readonly container: string;
  readonly worktreePath: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly tty: boolean;
  readonly forwardedNames: ReadonlyArray<string>;
  readonly setEnv: Readonly<Record<string, string>>;
  /** Run as this user instead of the container's; setup and secret writes use root. */
  readonly user?: string | undefined;
}): Array<string> {
  return [
    "exec",
    "-i",
    ...(input.tty ? ["-t"] : []),
    ...(input.user === undefined ? [] : ["-u", input.user]),
    "-w",
    input.worktreePath,
    ...input.forwardedNames.flatMap((name) => ["-e", name]),
    ...Object.entries(input.setEnv).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    input.container,
    input.command.replace(/^.*[\\/]/, ""),
    ...input.args,
  ];
}

/** Hosts the provider's own API needs, keyed by what the instance id names. */
const PROVIDER_HOSTS = {
  claude: [
    "api.anthropic.com",
    "statsig.anthropic.com",
    "claude.ai",
    "console.anthropic.com",
    "platform.claude.com",
    "sentry.io",
  ],
  codex: ["api.openai.com", "chatgpt.com", "auth.openai.com", "ab.chatgpt.com"],
} as const;

/**
 * A custom provider instance is named by its owner, so the driver is guessed
 * from the id; an id that names neither gets both lists rather than a thread
 * that cannot reach its own provider.
 */
export function restrictedAllowedHosts(input: {
  readonly providerInstanceIds: ReadonlyArray<string>;
  readonly allowedHosts: ReadonlyArray<string>;
}): Array<string> {
  const hosts = new Set<string>([HOST_ALIAS, ...input.allowedHosts]);
  for (const id of input.providerInstanceIds) {
    const lower = id.toLowerCase();
    const claude = lower.includes("claude");
    const codex = lower.includes("codex") || lower.includes("openai");
    for (const host of [
      ...(claude || !codex ? PROVIDER_HOSTS.claude : []),
      ...(codex || !claude ? PROVIDER_HOSTS.codex : []),
    ]) {
      hosts.add(host);
    }
  }
  return [...hosts].toSorted();
}
