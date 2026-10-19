import {
  CommandId,
  ContainerError,
  type ThreadContainerStatus,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadContainers from "../container/ThreadContainers.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

/**
 * Stops or rebuilds a container thread's container.
 *
 * The provider CLI and the terminals run inside that container, so they have
 * to end first. A provider session that outlives its container is a dead
 * process the session manager keeps handing back: the next turn would reuse it
 * and never reach `ThreadContainers.ensure`. Detaching the session makes the
 * next turn open a new one, which recreates the container and resumes from the
 * per-thread home volume.
 */
export class ContainerThreadControl extends Context.Service<
  ContainerThreadControl,
  {
    readonly stop: (threadId: ThreadId) => Effect.Effect<ThreadContainerStatus, ContainerError>;
    readonly rebuild: (threadId: ThreadId) => Effect.Effect<ThreadContainerStatus, ContainerError>;
  }
>()("t3/orchestration-v2/ContainerThreadControl") {}

export const layer = Layer.effect(
  ContainerThreadControl,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const terminals = yield* TerminalManager.TerminalManager;
    const containers = yield* ThreadContainers.ThreadContainers;
    const crypto = yield* Crypto.Crypto;

    const endThreadProcesses = Effect.fn("ContainerThreadControl.endThreadProcesses")(function* (
      threadId: ThreadId,
      reason: string,
    ) {
      const records = yield* threads.getThreadRecords(threadId, ["providerSessions"]);
      const commandBase = `container-control:${yield* crypto.randomUUIDv4()}`;
      // Interrupt first so the active run settles as interrupted instead of
      // failing when its provider process goes away.
      yield* threads
        .interruptThread({
          projectId: records.thread.projectId,
          commandId: CommandId.make(`${commandBase}:interrupt`),
          threadId,
          reason,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Container control could not interrupt the running turn", {
              threadId,
              cause,
            }),
          ),
        );
      yield* Effect.forEach(
        records.providerSessions.filter(
          (session) => session.status !== "stopped" && session.status !== "error",
        ),
        (session) =>
          // The command records the detach; the manager call makes it happen
          // now, before the container goes. The queued effect that follows finds
          // nothing attached and does nothing.
          threads
            .dispatch({
              type: "provider-session.detach",
              commandId: CommandId.make(`${commandBase}:detach:${session.id}`),
              threadId,
              providerSessionId: session.id,
              reason,
            })
            .pipe(
              Effect.andThen(
                sessions.detach({ providerSessionId: session.id, threadId, detail: reason }),
              ),
              Effect.catch((cause) =>
                Effect.logWarning("Container control could not detach a provider session", {
                  threadId,
                  providerSessionId: session.id,
                  cause,
                }),
              ),
            ),
        { discard: true },
      );
      yield* terminals.close({ threadId, deleteHistory: false }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Container control could not close the thread's terminals", {
            threadId,
            cause,
          }),
        ),
      );
    });

    const release = (
      operation: "stop" | "rebuild",
      reason: string,
    ): ContainerThreadControl["Service"]["stop"] =>
      Effect.fn(`ContainerThreadControl.${operation}`)(function* (threadId) {
        if (yield* containers.isContainerThread(threadId)) {
          yield* endThreadProcesses(threadId, reason).pipe(
            Effect.mapError(
              (cause) =>
                new ContainerError({
                  message: `Could not end the thread's running processes before the container ${operation}: ${String(cause)}`,
                }),
            ),
          );
        }
        return yield* containers[operation](threadId);
      });

    return ContainerThreadControl.of({
      stop: release("stop", "Container stopped."),
      rebuild: release("rebuild", "Container rebuilt."),
    });
  }),
);
