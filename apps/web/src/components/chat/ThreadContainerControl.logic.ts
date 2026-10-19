import type { ThreadContainerState, ThreadContainerStatus } from "@t3tools/contracts";

const CONTAINER_STATE_LABELS: Record<ThreadContainerState, string> = {
  absent: "Not created yet",
  preparing: "Preparing",
  running: "Running",
  stopped: "Stopped",
  error: "Error",
};

export function containerStateLabel(state: ThreadContainerState): string {
  return CONTAINER_STATE_LABELS[state];
}

export function canStopContainer(status: Pick<ThreadContainerStatus, "state">): boolean {
  return status.state === "running";
}

export function canRebuildContainer(status: Pick<ThreadContainerStatus, "state">): boolean {
  return status.state !== "preparing" && status.state !== "absent";
}

/** There is no Start action: the engine container is created or restarted by the next use. */
export function containerRestartHint(status: Pick<ThreadContainerStatus, "state">): string | null {
  switch (status.state) {
    case "absent":
    case "stopped":
      return "It starts on the next agent turn or terminal.";
    case "running":
      return "Stopping it ends running agent turns and terminals. The next agent turn or terminal starts it again.";
    case "error":
      return "The next agent turn or terminal tries again.";
    case "preparing":
      return null;
  }
}

export const REBUILD_CONTAINER_CONFIRMATION =
  "Rebuild this container?\nThis recreates the container. The running agent and terminals in it stop.";
