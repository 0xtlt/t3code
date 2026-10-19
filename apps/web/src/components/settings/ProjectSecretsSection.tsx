import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  ProjectSecretExposure,
  ProjectSecretScope,
  ProjectSecretSummary,
} from "@t3tools/contracts";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { projectSecretsEnvironment } from "../../state/container";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import {
  buildProjectSecretSetInput,
  describeProjectSecretRow,
  PROJECT_SECRET_EXPOSURE_LABELS,
  toggleScopeThread,
} from "./containerSettings.logic";
import { searchableSetting } from "./settingsSearch";
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const EXPOSURES = ["env", "file", "both"] as const satisfies ReadonlyArray<ProjectSecretExposure>;

interface SecretForm {
  readonly existing: boolean;
  readonly name: string;
  readonly value: string;
  readonly exposeAs: ProjectSecretExposure;
  readonly scope: ProjectSecretScope;
}

const NEW_SECRET_FORM: SecretForm = {
  existing: false,
  name: "",
  value: "",
  exposeAs: "env",
  scope: { type: "all" },
};

function threadLabel(thread: EnvironmentThreadShell): string {
  return thread.title.trim() === "" ? "Untitled thread" : thread.title;
}

/**
 * Names and metadata only: the server never returns a value, and the form never
 * prefills one. Saving an existing secret with an empty value keeps the stored one.
 */
export function ProjectSecretsSection({
  environmentId,
  environmentLabel,
  projectId,
  threads,
}: {
  environmentId: EnvironmentId;
  /** Set when the project spans several environments, so each section says which it edits. */
  environmentLabel: string | null;
  projectId: ProjectId;
  threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const list = useEnvironmentQuery(
    projectSecretsEnvironment.list({ environmentId, input: { projectId } }),
  );
  const canWrite = useAtomValue(projectSecretsEnvironment.set.permissionAtom(environmentId));
  const set = useAtomCommand(projectSecretsEnvironment.set, { reportFailure: false });
  const remove = useAtomCommand(projectSecretsEnvironment.remove, { reportFailure: false });
  const [form, setForm] = useState<SecretForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const secrets = list.data?.secrets ?? [];
  // Only container threads receive secrets, so only they can be scoped to.
  const containerThreads = threads.filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.projectId === projectId &&
      thread.container === true,
  );

  const closeForm = () => {
    setForm(null);
    setFormError(null);
  };

  const save = async () => {
    if (form === null || saving) return;
    const built = buildProjectSecretSetInput({ ...form, projectId });
    if ("error" in built) {
      setFormError(built.error);
      return;
    }
    setSaving(true);
    const result = await set({ environmentId, input: built.input });
    setSaving(false);
    if (result._tag === "Success") {
      closeForm();
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  const confirmDelete = async (secret: ProjectSecretSummary) => {
    const message = `Delete ${secret.name}?\nThreads stop receiving it the next time their container starts.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    const result = await remove({ environmentId, input: { projectId, name: secret.name } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not delete the secret",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const title = environmentLabel === null ? "Secrets" : `Secrets · ${environmentLabel}`;

  return (
    <SettingsSection
      id={environmentLabel === null ? searchableSetting("project-secrets").id : undefined}
      title={title}
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={!canWrite}
          onClick={() => setForm(NEW_SECRET_FORM)}
        >
          <PlusIcon />
          Add secret
        </Button>
      }
    >
      <SettingsRow
        title="Container threads"
        description="Injected into this project's container threads as environment variables, files at /run/secrets, or both. Values are write-only: they are never shown again."
      >
        {list.data?.keyStorage === "file" ? (
          <p className="pb-2 text-xs text-muted-foreground">
            No OS keychain was available, so the encryption key is stored next to the data and
            protected by file permissions.
          </p>
        ) : null}
        {list.error ? <p className="pb-2 text-xs text-destructive">{list.error}</p> : null}
      </SettingsRow>
      {secrets.map((secret) => (
        <SettingsRow
          key={secret.name}
          title={<span className="font-mono">{secret.name}</span>}
          description={describeProjectSecretRow(secret)}
          control={
            <div className="flex items-center gap-1.5">
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Edit ${secret.name}`}
                disabled={!canWrite}
                onClick={() =>
                  setForm({
                    existing: true,
                    name: secret.name,
                    value: "",
                    exposeAs: secret.exposeAs,
                    scope: secret.scope,
                  })
                }
              >
                <PencilIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Delete ${secret.name}`}
                disabled={!canWrite}
                onClick={() => void confirmDelete(secret)}
              >
                <Trash2Icon />
              </Button>
            </div>
          }
        />
      ))}

      <Dialog open={form !== null} onOpenChange={(open) => (open ? undefined : closeForm())}>
        <DialogPopup className="w-full sm:w-[28rem]">
          {form !== null ? (
            <>
              <DialogHeader>
                <DialogTitle>{form.existing ? `Edit ${form.name}` : "Add secret"}</DialogTitle>
                <DialogDescription>
                  {form.existing
                    ? "Leave the value empty to keep the stored one."
                    : "The value is encrypted on the server and never shown again."}
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <div className="grid gap-3">
                  <label className="grid gap-1.5 text-sm">
                    Name
                    <Input
                      font="mono"
                      disabled={form.existing}
                      value={form.name}
                      placeholder="API_KEY"
                      spellCheck={false}
                      autoCapitalize="off"
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                    />
                  </label>
                  <label className="grid gap-1.5 text-sm">
                    Value
                    <SecretInput
                      configured={form.existing}
                      value={form.value}
                      onChange={(event) => setForm({ ...form, value: event.target.value })}
                    />
                  </label>
                  <div className="grid gap-1.5 text-sm">
                    Expose as
                    <Select
                      value={form.exposeAs}
                      onValueChange={(value) =>
                        setForm({ ...form, exposeAs: value as ProjectSecretExposure })
                      }
                    >
                      <SelectTrigger aria-label="Expose as">
                        <SelectValue>
                          {(value: ProjectSecretExposure | null) =>
                            value ? PROJECT_SECRET_EXPOSURE_LABELS[value] : null
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        {EXPOSURES.map((exposure) => (
                          <SelectItem key={exposure} value={exposure}>
                            {PROJECT_SECRET_EXPOSURE_LABELS[exposure]}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                  <div className="grid gap-1.5 text-sm">
                    Available to
                    <Select
                      value={form.scope.type}
                      onValueChange={(value) =>
                        setForm({
                          ...form,
                          scope:
                            value === "all" ? { type: "all" } : { type: "threads", threadIds: [] },
                        })
                      }
                    >
                      <SelectTrigger aria-label="Available to">
                        <SelectValue>
                          {(value: "all" | "threads" | null) =>
                            value === "threads" ? "Specific threads" : "All container threads"
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        <SelectItem value="all">All container threads</SelectItem>
                        <SelectItem value="threads">Specific threads</SelectItem>
                      </SelectPopup>
                    </Select>
                    {form.scope.type === "threads" ? (
                      containerThreads.length > 0 ? (
                        <ul className="grid max-h-48 gap-1.5 overflow-y-auto">
                          {containerThreads.map((thread) => (
                            <li key={thread.id}>
                              <label className="flex items-center gap-2 text-sm">
                                <Checkbox
                                  checked={
                                    form.scope.type === "threads" &&
                                    form.scope.threadIds.includes(thread.id)
                                  }
                                  onCheckedChange={() =>
                                    setForm({
                                      ...form,
                                      scope: toggleScopeThread(form.scope, thread.id),
                                    })
                                  }
                                />
                                <span className="min-w-0 truncate">{threadLabel(thread)}</span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          This project has no container threads yet.
                        </p>
                      )
                    ) : null}
                  </div>
                  {formError ? <p className="text-xs text-destructive">{formError}</p> : null}
                </div>
              </DialogPanel>
              <DialogFooter>
                <Button variant="outline" onClick={closeForm}>
                  Cancel
                </Button>
                <Button disabled={saving} onClick={() => void save()}>
                  Save
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}
