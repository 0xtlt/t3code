import { ContainerError, type ThreadContainerStatus, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadContainers } from "./ThreadContainers.ts";

type WrapExecInput = Parameters<ThreadContainers["Service"]["wrapExec"]>[0];
type CopyInInput = Parameters<ThreadContainers["Service"]["copyIn"]>[0];

export interface FakeThreadContainers {
  readonly layer: Layer.Layer<ThreadContainers>;
  readonly ensured: Array<ThreadId>;
  readonly wrapped: Array<WrapExecInput>;
  readonly copied: Array<CopyInInput>;
}

/** Records what the scope asks of the container service; `containerThreads` are the threads created with `container: true`. */
export function makeFakeThreadContainers(options: {
  readonly containerThreads: ReadonlyArray<string>;
  readonly hostAddress?: string;
  readonly ensureError?: string;
  readonly wrapError?: string;
  /** Receives `stop`, `rebuild` and `remove` as they happen, for ordering assertions across fakes. */
  readonly log?: Array<string>;
}): FakeThreadContainers {
  const ensured: Array<ThreadId> = [];
  const wrapped: Array<WrapExecInput> = [];
  const copied: Array<CopyInInput> = [];
  const status = (threadId: ThreadId): ThreadContainerStatus => ({
    threadId,
    state: "running",
    forwardedEnv: [],
  });
  const service: ThreadContainers["Service"] = {
    engineStatus: Effect.die("not used"),
    isContainerThread: (threadId) => Effect.succeed(options.containerThreads.includes(threadId)),
    ensure: (threadId) => {
      ensured.push(threadId);
      return options.ensureError === undefined
        ? Effect.succeed(status(threadId))
        : Effect.fail(new ContainerError({ message: options.ensureError }));
    },
    wrapExec: (input) => {
      wrapped.push(input);
      return options.wrapError === undefined
        ? Effect.succeed({
            command: "docker",
            args: ["exec", "t3-container", input.command, ...input.args],
          })
        : Effect.fail(new ContainerError({ message: options.wrapError }));
    },
    copyIn: (input) => {
      copied.push(input);
      return Effect.void;
    },
    hostAddress: options.hostAddress ?? "host.docker.internal",
    status: (threadId) => Effect.succeed(status(threadId)),
    stop: (threadId) =>
      Effect.sync(() => {
        options.log?.push(`container.stop:${threadId}`);
        return status(threadId);
      }),
    rebuild: (threadId) =>
      Effect.sync(() => {
        options.log?.push(`container.rebuild:${threadId}`);
        return status(threadId);
      }),
    remove: () => Effect.void,
    reconcile: Effect.void,
  };
  return {
    layer: Layer.succeed(ThreadContainers, service),
    ensured,
    wrapped,
    copied,
  };
}
