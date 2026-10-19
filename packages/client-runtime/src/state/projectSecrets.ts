import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createProjectSecretsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // Values never come back over the wire: this list is names and metadata only.
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:project-secrets:list",
    tag: WS_METHODS.projectSecretsList,
    staleTimeMs: 0,
  });
  const scheduler = createAtomCommandScheduler();
  const lane = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;
  const refreshList = (
    target: {
      readonly environmentId: Parameters<typeof list>[0]["environmentId"];
      readonly input: { readonly projectId: Parameters<typeof list>[0]["input"]["projectId"] };
    },
    registry: { readonly refresh: (atom: ReturnType<typeof list>) => void },
  ) =>
    Effect.sync(() =>
      registry.refresh(
        list({ environmentId: target.environmentId, input: { projectId: target.input.projectId } }),
      ),
    );
  return {
    list,
    set: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-secrets:set",
      tag: WS_METHODS.projectSecretsSet,
      scheduler,
      concurrency: lane,
      onSettled: refreshList,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-secrets:remove",
      tag: WS_METHODS.projectSecretsRemove,
      scheduler,
      concurrency: lane,
      onSettled: refreshList,
    }),
  };
}
