import { createContainerEnvironmentAtoms } from "@t3tools/client-runtime/state/container";
import { createProjectSecretsEnvironmentAtoms } from "@t3tools/client-runtime/state/project-secrets";
import type { ContainerEngineStatus, EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useServerConfigs } from "./entities";
import { environmentServerConfigsAtom } from "./server";

export const containerEnvironment = createContainerEnvironmentAtoms(connectionAtomRuntime);
export const projectSecretsEnvironment =
  createProjectSecretsEnvironmentAtoms(connectionAtomRuntime);

export function useEnvironmentSupportsContainerThreads(environmentId: EnvironmentId | null) {
  const configs = useServerConfigs();
  return (
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.containerThreads === true
  );
}

export function readEnvironmentSupportsContainerThreads(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .containerThreads === true
  );
}

export function useEnvironmentSupportsProjectSecrets(environmentId: EnvironmentId | null) {
  const configs = useServerConfigs();
  return (
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.projectSecrets === true
  );
}

const NO_ENGINE_STATUS = Atom.make<AsyncResult.AsyncResult<ContainerEngineStatus, never>>(
  AsyncResult.initial(),
).pipe(Atom.keepAlive, Atom.withLabel("web-container:no-engine-status"));

/**
 * Mounting this asks the engine; the result is dropped shortly after the last
 * reader goes away. Call it from UI that only exists while a picker or panel is
 * open, so a closed surface never reaches the engine.
 */
export function useContainerEngineStatus(
  environmentId: EnvironmentId | null,
): ContainerEngineStatus | null {
  const result = useAtomValue<AsyncResult.AsyncResult<ContainerEngineStatus, unknown>>(
    environmentId === null
      ? NO_ENGINE_STATUS
      : containerEnvironment.engineStatus({ environmentId, input: undefined }),
  );
  return Option.getOrNull(AsyncResult.value(result));
}

export function resolveContainerUnavailableReason(
  status: ContainerEngineStatus | null,
): string | null {
  if (status === null || status.available) return null;
  return status.message ?? "No container engine found";
}
