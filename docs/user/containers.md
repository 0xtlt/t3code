# Container threads

A container thread runs its agent in an isolated container instead of directly on your machine.
The agent, its terminals, and your project scripts run inside the container, and the only project
files it can see are the thread's own worktree. Other folders, your home directory, other
processes, and credentials you did not hand over stay out of reach.

Container threads need Docker or a Docker-compatible engine: Docker Desktop, OrbStack, Colima, or
Podman. Claude and Codex can run in a container; other providers can't yet.

## Start a container thread

Pick **Container** next to **Local** and **Worktree** when you start a new thread. T3 Code creates
a worktree for the thread, prepares its container, runs the setup command, then starts the agent.
The first container for a project can take a few minutes while the image builds; later threads
reuse it.

To make it the default for a project, choose **Container** as the default for new threads in the
project's settings, or add `"defaultThreadContainer": true` to the repository's `t3.json`.

Agents can launch container threads through T3 Code's MCP tools with
`"workspaceStrategy": { "type": "worktree", "baseRef": "main", "container": true }`.

## Describe the environment

T3 Code looks for the environment definition in the thread's branch, in this order:

1. The `container` section of `t3.json`.
2. The `devcontainer.json` that section names, or `.devcontainer/devcontainer.json`.
3. A default image with Node.js, git, and common build tools.

```json
{
  "container": {
    "dockerfile": ".t3/Dockerfile",
    "setupCommand": "pnpm install",
    "forwardEnv": ["NPM_TOKEN"],
    "cpus": 4,
    "memory": "8g"
  }
}
```

From a `devcontainer.json`, T3 Code uses `image`, `build`, `postCreateCommand`, `containerEnv`, and
`remoteEnv`. Features and Compose files aren't supported; the container status tells you when a
definition uses them.

T3 Code adds the Claude and Codex command-line tools to the image if it doesn't already have them,
which needs `npm` in the image. When the definition changes, the next agent turn or terminal
recreates the container. **Rebuild** in the thread's container menu forces a fresh image.

## Sign in the agent

Your machine's environment variables are not passed into the container. T3 Code forwards only:

- The variables the provider needs to sign in, such as `ANTHROPIC_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN`, and `OPENAI_API_KEY`, when they are set.
- Codex's saved sign-in, which is copied into the container.
- The names listed in `forwardEnv` in `t3.json` or in **Settings → General → Containers**.
- The project's secrets.

On macOS, Claude stores a subscription sign-in in the keychain, where the container can't read it.
Run `claude setup-token` and set the token it prints as `CLAUDE_CODE_OAUTH_TOKEN` in the Claude
provider's environment settings, or add it as a project secret.

## Project secrets

Add secrets such as API keys in the project's settings under **Secrets**. Each secret is injected
into the project's container threads as an environment variable, as a read-only file at
`/run/secrets/<NAME>`, or both. A secret can apply to every thread of the project or only to the
threads you pick.

After you save a secret, T3 Code shows only its name. Secrets are stored encrypted on the machine
that runs T3 Code, with the key in the system keychain when one is available. They are never
written to your repository. T3 Code masks secret values in terminal output and in the agent's tool
output, but an agent that transforms a value can still reveal it, so give a thread only the
secrets it needs. A value you paste into a message is part of the conversation, not a secret: add it
in the project's settings instead.

A changed secret reaches a running container the next time nothing is running in it, or when you
choose **Rebuild**.

## Network

By default the container can reach the internet. To limit it, set `"network": "restricted"` in the
`container` section: the container can then reach only the provider's API, T3 Code, and the hosts
you list in `allowedHosts`.

```json
{ "container": { "network": "restricted", "allowedHosts": ["registry.npmjs.org", "*.github.com"] } }
```

## Stop and clean up

The thread's container menu shows its state and lets you **Stop** or **Rebuild** it. Both end the
agent's current turn and the thread's terminals. The next agent turn or terminal starts the container
again, and the agent continues the same conversation. Archiving a thread removes its
container but keeps the agent's history so you can continue after unarchiving. Deleting a thread
removes everything, including its saved agent state.

## Limits

- Servers started inside the container, such as a dev server, aren't reachable from your machine,
  so they don't appear in previews.
- On Linux, T3 Code must listen on an address the container can reach for the agent to use T3
  Code's tools.
