import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2ProviderSession,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeFakeThreadContainers } from "../container/ThreadContainers.testkit.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ContainerThreadControl from "./ContainerThreadControl.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const CONTAINER_THREAD = ThreadId.make("thread-container-control");
const HOST_THREAD = ThreadId.make("thread-container-control-host");
const PROJECT = ProjectId.make("project-container-control");

const liveSession = {
  id: ProviderSessionId.make("session-live"),
  status: "ready",
} as OrchestrationV2ProviderSession;
const stoppedSession = {
  id: ProviderSessionId.make("session-stopped"),
  status: "stopped",
} as OrchestrationV2ProviderSession;

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const makeHarness = () => {
  const log: Array<string> = [];
  const containers = makeFakeThreadContainers({ containerThreads: [CONTAINER_THREAD], log });
  const layer = ContainerThreadControl.layer.pipe(
    Layer.provide(containers.layer),
    Layer.provide(Layer.succeed(Crypto.Crypto, testCrypto)),
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: (threadId: ThreadId) =>
          Effect.succeed({
            thread: { id: threadId, projectId: PROJECT },
            providerSessions: [liveSession, stoppedSession],
          } as never),
        interruptThread: (input) =>
          Effect.sync(() => {
            log.push(`interrupt:${input.threadId}`);
            return { type: "no_active_run" } as const;
          }),
        dispatch: (command) =>
          Effect.sync(() => {
            log.push(
              command.type === "provider-session.detach"
                ? `command.detach:${command.providerSessionId}`
                : command.type,
            );
            return {} as never;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        detach: (input) =>
          Effect.sync(() => {
            log.push(`session.detach:${input.providerSessionId}`);
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(TerminalManager.TerminalManager)({
        close: (input) =>
          Effect.sync(() => {
            log.push(`terminals.close:${input.threadId}:${input.deleteHistory}`);
          }),
      }),
    ),
  );
  return { log, layer };
};

const expectedEnding = (operation: "stop" | "rebuild") => [
  `interrupt:${CONTAINER_THREAD}`,
  "command.detach:session-live",
  "session.detach:session-live",
  `terminals.close:${CONTAINER_THREAD}:false`,
  `container.${operation}:${CONTAINER_THREAD}`,
];

it.effect.each(["stop", "rebuild"] as const)(
  "%s ends the provider session and terminals before the container",
  (operation) => {
    const { log, layer } = makeHarness();
    return Effect.gen(function* () {
      const control = yield* ContainerThreadControl.ContainerThreadControl;
      yield* control[operation](CONTAINER_THREAD);
      assert.deepEqual(log, expectedEnding(operation));
    }).pipe(Effect.provide(layer));
  },
);

it.effect("leaves a non-container thread to the container service", () => {
  const { log, layer } = makeHarness();
  return Effect.gen(function* () {
    const control = yield* ContainerThreadControl.ContainerThreadControl;
    yield* control.stop(HOST_THREAD);
    assert.deepEqual(log, [`container.stop:${HOST_THREAD}`]);
  }).pipe(Effect.provide(layer));
});

void CommandId;
