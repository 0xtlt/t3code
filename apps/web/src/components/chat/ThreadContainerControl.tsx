import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { ContainerIcon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { containerEnvironment } from "../../state/container";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import {
  canRebuildContainer,
  canStopContainer,
  containerRestartHint,
  containerStateLabel,
  REBUILD_CONTAINER_CONFIRMATION,
} from "./ThreadContainerControl.logic";

function StatusRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all text-right">{children}</dd>
    </div>
  );
}

/** Mounted only while the popover is open, so the engine is asked on open and never polled. */
function ThreadContainerStatusPanel({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const result = useAtomValue(
    containerEnvironment.threadStatus({ environmentId, input: { threadId } }),
  );
  const canOperate = useAtomValue(containerEnvironment.stopThread.permissionAtom(environmentId));
  const stop = useAtomCommand(containerEnvironment.stopThread, { reportFailure: false });
  const rebuild = useAtomCommand(containerEnvironment.rebuildThread, { reportFailure: false });
  const [pending, setPending] = useState<"stop" | "rebuild" | null>(null);
  const status = Option.getOrNull(AsyncResult.value(result));

  const run = async (action: "stop" | "rebuild") => {
    if (action === "rebuild") {
      const confirmed =
        (await requestConfirmDialog(REBUILD_CONTAINER_CONFIRMATION, { variant: "destructive" })) ??
        window.confirm(REBUILD_CONTAINER_CONFIRMATION);
      if (!confirmed) return;
    }
    setPending(action);
    const outcome = await (action === "stop" ? stop : rebuild)({
      environmentId,
      input: { threadId },
    });
    setPending(null);
    if (outcome._tag === "Failure" && !isAtomCommandInterrupted(outcome)) {
      const error = squashAtomCommandFailure(outcome);
      toastManager.add({
        type: "error",
        title:
          action === "stop" ? "Could not stop the container" : "Could not rebuild the container",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  if (status === null) {
    return result._tag === "Failure" ? (
      <p className="text-sm text-muted-foreground">Could not read the container status.</p>
    ) : (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner size="sm" /> Checking the container engine
      </p>
    );
  }

  const restartHint = containerRestartHint(status);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium text-sm">Container</h3>
        <span className="text-muted-foreground text-xs">{containerStateLabel(status.state)}</span>
      </div>
      <dl className="flex flex-col gap-1.5">
        {status.image ? <StatusRow label="Image">{status.image}</StatusRow> : null}
        {status.source ? <StatusRow label="Defined by">{status.source}</StatusRow> : null}
        {status.network ? <StatusRow label="Network">{status.network}</StatusRow> : null}
        <StatusRow label="Forwarded env">
          {status.forwardedEnv.length > 0 ? status.forwardedEnv.join(", ") : "None"}
        </StatusRow>
      </dl>
      {status.stale ? (
        <Alert variant="warning">
          <AlertDescription>
            The definition or the project secrets changed. The container is recreated once nothing
            runs in it, or rebuild it now.
          </AlertDescription>
        </Alert>
      ) : null}
      {status.message ? <p className="text-muted-foreground text-xs">{status.message}</p> : null}
      {restartHint ? <p className="text-muted-foreground text-xs">{restartHint}</p> : null}
      <div className="flex justify-end gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={!canOperate || pending !== null || !canStopContainer(status)}
          onClick={() => void run("stop")}
        >
          {pending === "stop" ? <Spinner /> : null}
          Stop
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!canOperate || pending !== null || !canRebuildContainer(status)}
          onClick={() => void run("rebuild")}
        >
          {pending === "rebuild" ? <Spinner /> : null}
          Rebuild
        </Button>
      </div>
    </div>
  );
}

export function ThreadContainerControl({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label="Container status"
            className="shrink-0"
          />
        }
      >
        <ContainerIcon />
        Container
      </PopoverTrigger>
      <PopoverPopup width="md" align="start">
        <ThreadContainerStatusPanel environmentId={environmentId} threadId={threadId} />
      </PopoverPopup>
    </Popover>
  );
}
