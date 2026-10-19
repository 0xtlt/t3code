import type {
  ContainerEnginePreference,
  ContainerEngineStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { containerEnvironment } from "../../state/container";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { searchableSetting } from "./settingsSearch";
import {
  addForwardedEnvName,
  CONTAINER_ENGINE_LABELS,
  containerRuntimePatch,
  parseCpuLimitInput,
  parseMemoryLimitInput,
  removeForwardedEnvName,
} from "./containerSettings.logic";
import { DraftInput } from "../ui/draft-input";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const ENGINE_PREFERENCES = ["auto", "docker", "podman"] as const;

function describeEngine(status: ContainerEngineStatus | null, error: string | null): string {
  if (status === null) return error ?? "Checking the container engine…";
  if (!status.available) return status.message ?? "No container engine found.";
  return [status.kind, status.version].filter(Boolean).join(" ") || "Container engine available.";
}

/**
 * Machine-level defaults for container threads. A repository's t3.json can
 * still override the limits per project.
 */
export function ContainerSettings() {
  const { connectedEnvironments, environment } = useSettingsScope();
  const supported =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.containerThreads === true,
    );
  if (!supported) return null;
  return <ContainerSettingsSection environmentId={environment?.environmentId ?? null} />;
}

function ContainerSettingsSection({ environmentId }: { environmentId: EnvironmentId | null }) {
  const runtime = useScopedSettings((settings) => settings.containerRuntime);
  const updateSettings = useUpdateScopedSettings();
  const status = useEnvironmentQuery(
    environmentId === null
      ? null
      : containerEnvironment.engineStatus({ environmentId, input: undefined }),
  );
  const [forwardDraft, setForwardDraft] = useState("");
  const [forwardError, setForwardError] = useState<string | null>(null);

  const rejected = (title: string, description: string) =>
    toastManager.add({ type: "error", title, description });

  const addForwarded = () => {
    if (forwardDraft.trim() === "") return;
    const next = addForwardedEnvName(runtime.forwardEnv, forwardDraft);
    if ("error" in next) {
      setForwardError(next.error);
      return;
    }
    setForwardError(null);
    setForwardDraft("");
    updateSettings(containerRuntimePatch({ forwardEnv: next.names }));
  };

  return (
    <SettingsSection id={searchableSetting("containers").id} title="Containers">
      <SettingsRow
        title="Engine"
        description={
          environmentId === null
            ? "Docker or Podman runs container threads."
            : describeEngine(status.data, status.error)
        }
        resetAction={
          runtime.engine !== "auto" ? (
            <SettingResetButton
              label="container engine"
              onClick={() => updateSettings(containerRuntimePatch({ engine: "auto" }))}
            />
          ) : null
        }
        control={
          <div className="flex items-center gap-2">
            {environmentId !== null ? (
              <Button
                size="sm"
                variant="outline"
                disabled={status.isPending}
                onClick={() => status.refresh()}
              >
                Check again
              </Button>
            ) : null}
            <Select
              value={runtime.engine}
              onValueChange={(value) => {
                if ((ENGINE_PREFERENCES as readonly string[]).includes(value as string)) {
                  updateSettings(
                    containerRuntimePatch({ engine: value as ContainerEnginePreference }),
                  );
                }
              }}
            >
              <SelectTrigger size="sm" aria-label="Container engine">
                <SelectValue>
                  {(value: ContainerEnginePreference | null) =>
                    value ? CONTAINER_ENGINE_LABELS[value] : "Automatic"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {ENGINE_PREFERENCES.map((engine) => (
                  <SelectItem key={engine} value={engine}>
                    {CONTAINER_ENGINE_LABELS[engine]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        }
      />
      <SettingsRow
        title="Default CPUs"
        description="CPU limit for each container. A repository's t3.json can override it."
        resetAction={
          runtime.cpus !== null ? (
            <SettingResetButton
              label="default CPUs"
              onClick={() => updateSettings(containerRuntimePatch({ cpus: null }))}
            />
          ) : null
        }
        control={
          <DraftInput
            size="sm"
            className="w-28"
            aria-label="Default CPUs"
            inputMode="decimal"
            placeholder="No limit"
            value={runtime.cpus === null ? "" : String(runtime.cpus)}
            onCommit={(next) => {
              const parsed = parseCpuLimitInput(next);
              if ("error" in parsed) {
                rejected("Default CPUs not saved", parsed.error);
                return;
              }
              if (parsed.value !== runtime.cpus) {
                updateSettings(containerRuntimePatch({ cpus: parsed.value }));
              }
            }}
          />
        }
      />
      <SettingsRow
        title="Default memory"
        description="Memory limit for each container, like 4g or 512m."
        resetAction={
          runtime.memory !== null ? (
            <SettingResetButton
              label="default memory"
              onClick={() => updateSettings(containerRuntimePatch({ memory: null }))}
            />
          ) : null
        }
        control={
          <DraftInput
            size="sm"
            className="w-28"
            aria-label="Default memory"
            placeholder="No limit"
            value={runtime.memory ?? ""}
            onCommit={(next) => {
              const parsed = parseMemoryLimitInput(next);
              if ("error" in parsed) {
                rejected("Default memory not saved", parsed.error);
                return;
              }
              if (parsed.value !== runtime.memory) {
                updateSettings(containerRuntimePatch({ memory: parsed.value }));
              }
            }}
          />
        }
      />
      <SettingsRow
        title="Forwarded environment variables"
        description="Names of variables copied from this machine into every container thread. Values are never stored or shown. Nothing else crosses by default."
        control={
          <Input
            size="sm"
            className="w-full sm:w-56"
            aria-label="Add a forwarded environment variable name"
            placeholder="NPM_TOKEN"
            value={forwardDraft}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(event) => {
              setForwardDraft(event.target.value);
              setForwardError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") addForwarded();
            }}
            onBlur={addForwarded}
          />
        }
      >
        {forwardError ? <p className="pb-2 text-xs text-destructive">{forwardError}</p> : null}
        {runtime.forwardEnv.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5 pb-2">
            {runtime.forwardEnv.map((name) => (
              <li
                key={name}
                className="flex items-center gap-1 rounded-sm border bg-muted/40 py-0.5 pr-0.5 pl-2 font-mono text-xs"
              >
                {name}
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  aria-label={`Stop forwarding ${name}`}
                  onClick={() =>
                    updateSettings(
                      containerRuntimePatch({
                        forwardEnv: removeForwardedEnvName(runtime.forwardEnv, name),
                      }),
                    )
                  }
                >
                  <XIcon className="size-3" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
