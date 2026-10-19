import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { createProjectSecretsEnvironmentAtoms } from "@t3tools/client-runtime/state/project-secrets";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

const shared = createProjectSecretsEnvironmentAtoms(connectionAtomRuntime);

// `set` and `remove` are the shared guarded commands. The section loads its list
// imperatively on mount and after each save, so `list` stays a one-shot command
// here instead of the query atom web subscribes to.
export const projectSecretsEnvironment = {
  list: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-secrets:list",
    tag: WS_METHODS.projectSecretsList,
  }),
  set: shared.set,
  remove: shared.remove,
};
