# Container threads

> For maintainers. Using T3 Code? See [containers](../user/containers.md).

A container thread runs its provider CLI, its terminals, and its project scripts inside a
per-thread container. The only project directory the container sees is the thread's worktree.
The goal is the one Cursor's cloud agents serve: the agent cannot touch the rest of the machine
(files, tools, processes, credentials it was not given), and its toolchain comes from a
declarative definition checked into the repository.

## Model

- A thread's `container` flag is set at creation and never changes. It lives on
  `OrchestrationV2AppThread` (and the shell) as an optional field, so old snapshots and old
  clients decode unchanged.
- Container mode is chosen with `workspaceStrategy.container: true` on a `worktree` or
  `existing_worktree` launch. A `root` launch with `container` is rejected: the main checkout is
  shared, and isolating one thread from a directory every other thread writes to is not isolation.
- The per-project default is `defaultThreadContainer`, a project-scoped, t3.json-backed setting
  next to `defaultThreadEnvMode`. It is a separate boolean rather than a third `ThreadEnvMode`
  literal because released clients decode `defaultThreadEnvMode` as a required `local | worktree`
  literal; an unknown value would fail their whole settings snapshot. Clients present it as a third
  "Container" choice beside Local and Worktree.
- Servers advertise `capabilities.containerThreads`. Clients hide the Container choice without it.
- Runtime state (is the container running, which image) is not orchestration state. It lives in
  the engine, read through `container.threadStatus`; containers carry labels so a restarted server
  finds its own.

## Execution seam

Every CLI-spawning provider and the terminal already pass their final launch command through
[`AgentScope.wrap`](../../packages/shared/src/AgentScope.ts). Container threads decorate that
service: for a container thread, `wrap` returns `docker exec -i [-t] -w <worktree> -e NAME…
<container> <command> …`. Adapters keep spawning a local process and talking stdio to it, so no
protocol code changes.

Mounts use the host's absolute paths: the worktree, and the repository's git common directory
(the worktree's `.git` file points there, so in-container git needs it). With identical paths, the
cwd, file paths in tool calls, diffs, checkpoints, and the provider's resume state need no
translation. Checkpoints, diffs, and git status keep running on the host against the same files.

`HOME` is `/t3home`, a per-thread named volume. It holds the provider's session state, so an
archived and unarchived thread can resume its conversation even after its container was removed.

The container runs as the host user's uid:gid, so files the agent writes stay owned by the user
and host-side `git clean` and worktree removal keep working on Linux. The container is `--init`
so orphaned tool processes are reaped.

## Definition and images

The base comes from, in order: t3.json `container` (`image` or `dockerfile`), the devcontainer.json
it names or `.devcontainer/devcontainer.json` (`image`, `build.dockerfile`/`context`/`args`,
`postCreateCommand`, `containerEnv`), then the default `node:24-bookworm`. The definition is read
from the thread's worktree, so a branch can change its own environment.

T3 Code builds a thin derived image on top: it installs the agent CLIs the base lacks (with npm)
and prepares `/t3home`. The tag is a hash of the base definition and the layer version, so an
unchanged definition never rebuilds. A changed definition makes the next `ensure` recreate the
container; `container.rebuildThread` forces a rebuild.

Devcontainer features, compose files, and lifecycle hooks other than `postCreateCommand` are not
supported; they are reported, not silently ignored.

## Providers

| Provider                        | In a container | Why                                                                           |
| ------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| Claude                          | Yes            | Native `claude` binary over stdio.                                            |
| Codex                           | Yes            | `codex app-server` over stdio; cwd travels in thread params.                  |
| Cursor                          | No             | The SDK runs tools inside the T3 server process; there is no process to move. |
| OpenCode                        | No             | Shared HTTP server per instance, reached on a host port.                      |
| Grok, Antigravity, ACP registry | No             | T3's MCP reaches them through a stdio bridge that is the T3 binary itself.    |
| Pi, Muse                        | No             | Host-materialized extensions and SDK-managed spawns.                          |

Starting a session for an unsupported provider in a container thread fails with a message that
names the provider; it never falls back to the host.

## Credentials and environment

Nothing from the host environment crosses by default. A variable is forwarded by name only when it
is in t3.json `forwardEnv`, the machine's `containerRuntime.forwardEnv`, the provider's auth list
(for example `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`), or is set by the
adapter itself. Values never appear in argv: `docker exec -e NAME` reads them from the env the CLI
is spawned with. File credentials are copied, not mounted: Codex's `auth.json` is copied into the
container's `CODEX_HOME`. The Claude subscription login lives in the macOS keychain and cannot be
copied; users set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or an API key instead.

## Project secrets

A project can hold named secrets (`projectSecrets.*` RPCs, the project's settings page, and MCP
tools). They are injected into every container thread of the project, or only into the threads a
secret is scoped to, as environment variables, as read-only files at `/run/secrets/<NAME>`, or
both.

- **Write-only.** Values go in through `set` and never leave the server again: list results carry
  names, exposure, scope, and timestamps. MCP `set` also accepts a `secretRef` from
  `request_secret`, so an agent can store a secret the user typed without ever seeing it.
- **Encrypted at rest.** Each project's secrets are one AES-256-GCM blob in the server secret store.
  The key lives in the OS keychain (macOS `security`, Linux `secret-tool`) and falls back to a 0600
  key file in the secrets directory where no keychain is reachable, such as a headless server. The
  list result reports which one is in use so the UI can say so.
- **Injection.** Env secrets are passed when the container is created, by name, so values never
  appear in argv. File secrets are written over `docker exec` stdin into a root-owned tmpfs at
  `/run/secrets`, so they never touch the host disk or the worktree, and the agent's user can read
  but not change them. A container's labels carry a keyed fingerprint of its secrets; a change
  recreates the container on next use once nothing is running in it, and the thread status reports
  it as stale until then.
- **Never persisted elsewhere.** Secrets are not in t3.json, the worktree, checkpoints, settings,
  or logs. Terminal output, provider tool output, and the raw provider event logs of a thread are
  passed through a redactor that masks the thread's secret values before they are streamed or
  stored. Redaction is best effort: an agent that encodes or splits a value defeats it. Traces never
  carry tool parameters of tools that take secret values (`SensitiveParameters` in
  `apps/server/src/mcp/sensitiveParameters.ts`); mark a new such tool with it, because Effect
  records every MCP tool's raw parameters on its span.
- **No per-thread values.** A scope picks which threads get a secret; a thread cannot override a
  value. Two secrets with different scopes cover the cases we know of.

T3's MCP server is reached at `host.docker.internal`, which Docker Desktop, OrbStack, and Colima
resolve to the host; on Linux the container gets `--add-host host.docker.internal:host-gateway`.

## Network

`open` (default) is the engine's bridge network. `restricted` attaches the container to an
internal network with no route out, plus an egress proxy sidecar that allows only the provider's
API hosts, `allowedHosts`, and the T3 server. Traffic that ignores `HTTPS_PROXY` fails closed.

## Lifecycle

- Created on first use: the launch's "Prepare container" setup stage, a provider session, or a
  terminal. The setup command runs once per container, before the agent starts.
- Archive removes the container and keeps the home volume. Unarchive needs nothing: the next use
  recreates it.
- Delete removes the container, its network, and its home volume.
- Stop and rebuild go through `ContainerThreadControl`, not `ThreadContainers` directly: the provider
  session is detached and the terminals closed first. A session manager entry that outlives its
  container is a dead process the next turn would reuse without ever calling `ensure`. For a
  container thread, `detach` releases the session even for providers that normally share one
  process across threads (Codex), for the same reason.
- On startup the server removes containers labeled for this environment whose thread is gone or
  archived.
- CPU and memory limits come from t3.json, then the machine's `containerRuntime` defaults.

## Known limits

- Ports opened inside the container are not published, so port discovery and previews do not see
  them.
- Terminal busy detection and port attribution walk the host process tree, which ends at the
  engine CLI.
- Image attachments reach the agent inline, but non-image file attachments are named to the agent by
  their host path in the attachments directory, which the container does not mount.
- Live command output holds back only a possible secret prefix between chunks; a partially streamed
  tool item can show the start of a secret until its next update masks it.
- Apple's `container` CLI is not supported; it lacks `exec` parity with Docker.
