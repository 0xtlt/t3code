import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createContainerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // Engine and container state are read when a surface opens, never polled.
  // A zero idle TTL drops the result with its last reader, so the next open
  // asks the engine again instead of showing a stale "running".
  const threadStatus = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:container:thread-status",
    tag: WS_METHODS.containerThreadStatus,
    staleTimeMs: 0,
    idleTtlMs: 0,
  });
  const refreshThreadStatus = (
    target: {
      readonly environmentId: Parameters<typeof threadStatus>[0]["environmentId"];
      readonly input: {
        readonly threadId: Parameters<typeof threadStatus>[0]["input"]["threadId"];
      };
    },
    registry: { readonly refresh: (atom: ReturnType<typeof threadStatus>) => void },
  ) => Effect.sync(() => registry.refresh(threadStatus(target)));
  return {
    engineStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:container:engine-status",
      tag: WS_METHODS.containerEngineStatus,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    threadStatus,
    stopThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:container:stop-thread",
      tag: WS_METHODS.containerStopThread,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.threadId}`,
      },
      onSettled: refreshThreadStatus,
    }),
    // Shares the stop lane so a rebuild and a stop on one thread never race.
    rebuildThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:container:rebuild-thread",
      tag: WS_METHODS.containerRebuildThread,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.threadId}`,
      },
      onSettled: refreshThreadStatus,
    }),
  };
}
