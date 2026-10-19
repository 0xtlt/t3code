import type { EnvironmentId } from "@t3tools/contracts";
import { ContainerIcon } from "lucide-react";

import { resolveEnvModeLabel } from "./BranchToolbar.logic";
import { MenuRadioItem } from "./ui/menu";
import { SelectItem } from "./ui/select";
import { resolveContainerUnavailableReason, useContainerEngineStatus } from "../state/container";

function ContainerEnvModeContent({ reason }: { reason: string | null }) {
  return (
    <span className="flex min-w-0 items-start gap-1.5">
      <ContainerIcon className="mt-1 size-3" />
      <span className="flex min-w-0 flex-col">
        <span>{resolveEnvModeLabel("container")}</span>
        {reason ? <span className="min-w-0 text-xs text-muted-foreground">{reason}</span> : null}
      </span>
    </span>
  );
}

/**
 * The Container choice of a workspace picker. It is mounted with the open
 * picker, so the engine is asked when the picker opens and not before. An
 * engine that is down leaves the choice visible but disabled, with its reason.
 */
export function ContainerSelectItem({ environmentId }: { environmentId: EnvironmentId }) {
  const reason = resolveContainerUnavailableReason(useContainerEngineStatus(environmentId));
  return (
    <SelectItem value="container" disabled={reason !== null}>
      <ContainerEnvModeContent reason={reason} />
    </SelectItem>
  );
}

export function ContainerMenuRadioItem({
  environmentId,
  disabled,
}: {
  environmentId: EnvironmentId;
  disabled: boolean;
}) {
  const reason = resolveContainerUnavailableReason(useContainerEngineStatus(environmentId));
  return (
    <MenuRadioItem disabled={disabled || reason !== null} value="container" closeOnClick>
      <ContainerEnvModeContent reason={reason} />
    </MenuRadioItem>
  );
}
