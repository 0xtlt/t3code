import {
  type EnvironmentId,
  type ProjectId,
  type ProjectSecretExposure,
  type ProjectSecretSummary,
  type ProjectSecretsListResult,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import * as Dialog from "../../../components/ui/Dialog";
import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { projectSecretsEnvironment } from "../../../state/project-secrets-rpc";
import { useAtomCommand } from "../../../state/use-atom-command";
import {
  PROJECT_SECRET_EXPOSURE_CHOICES,
  buildProjectSecretInput,
  describeProjectSecret,
} from "../project-secrets-presentation";
import { SettingsActionRow } from "./SettingsActionRow";
import { SettingsChoiceRow } from "./SettingsChoiceRow";
import { SettingsSection } from "./SettingsSection";

const INPUT_CLASS = "min-h-11 rounded-xl border-continuous bg-card px-3 text-base text-foreground";

/**
 * Names and metadata only: the server never returns a value, and the form
 * never prefills one. Saving an existing name replaces its value.
 */
export function ProjectSecretsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly projectId: ProjectId;
  readonly canWrite: boolean;
}) {
  const list = useAtomCommand(projectSecretsEnvironment.list, {
    label: "project secrets list",
    reportFailure: false,
  });
  const set = useAtomCommand(projectSecretsEnvironment.set, {
    label: "project secret save",
    reportFailure: false,
  });
  const remove = useAtomCommand(projectSecretsEnvironment.remove, {
    label: "project secret delete",
    reportFailure: false,
  });
  const [loaded, setLoaded] = useState<ProjectSecretsListResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [exposeAs, setExposeAs] = useState<ProjectSecretExposure>("env");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { environmentId, projectId } = props;
  const reload = useCallback(async () => {
    const result = await list({ environmentId, input: { projectId } });
    if (result._tag === "Success") {
      setLoaded(result.value);
      setLoadError(null);
    } else if (!isAtomCommandInterrupted(result)) {
      setLoadError(String(squashAtomCommandFailure(result)));
    }
  }, [environmentId, list, projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const closeForm = () => {
    setAdding(false);
    setName("");
    setValue("");
    setExposeAs("env");
    setFormError(null);
  };

  const save = async () => {
    if (busy) return;
    const built = buildProjectSecretInput({ projectId, name, value, exposeAs });
    if ("error" in built) {
      setFormError(built.error);
      return;
    }
    setBusy(true);
    const result: AtomCommandResult<unknown, unknown> = await set({
      environmentId,
      input: built.input,
    });
    setBusy(false);
    if (result._tag === "Success") {
      closeForm();
      await reload();
    } else if (!isAtomCommandInterrupted(result)) {
      setFormError(String(squashAtomCommandFailure(result)));
    }
  };

  const confirmDelete = (secret: ProjectSecretSummary) => {
    Dialog.confirm({
      title: `Delete ${secret.name}?`,
      message: "Threads stop receiving it the next time their container starts.",
      confirmText: "Delete",
      destructive: true,
      onConfirm: () => {
        void (async () => {
          const result = await remove({ environmentId, input: { projectId, name: secret.name } });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            Dialog.alert("Could not delete secret", String(squashAtomCommandFailure(result)));
          }
          await reload();
        })();
      },
    });
  };

  const title = props.environmentLabel === null ? "Secrets" : `Secrets · ${props.environmentLabel}`;
  const secrets = loaded?.secrets ?? [];

  return (
    <SettingsSection
      title={title}
      footer={
        loaded?.keyStorage === "file"
          ? "No OS keychain was available, so the encryption key is stored next to the data, protected by file permissions."
          : "Injected into this project's container threads. Values are write-only and never shown again."
      }
    >
      {loadError !== null ? (
        <Text className="px-4 py-3 text-sm text-danger-foreground">{loadError}</Text>
      ) : null}
      {secrets.map((secret, index) => (
        <View key={secret.name} className={index > 0 ? "border-t border-border-subtle" : undefined}>
          <SettingsActionRow
            label={secret.name}
            description={describeProjectSecret(secret)}
            disabled={!props.canWrite}
            onPress={() => confirmDelete(secret)}
          />
        </View>
      ))}
      {adding ? (
        <View className="gap-3 border-t border-border-subtle p-4">
          <AppTextInput
            accessibilityLabel="Secret name"
            className={INPUT_CLASS}
            placeholder="NAME"
            value={name}
            onChangeText={setName}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!busy}
          />
          <AppTextInput
            accessibilityLabel="Secret value"
            className={INPUT_CLASS}
            placeholder="Value"
            value={value}
            onChangeText={setValue}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            textContentType="none"
            importantForAutofill="no"
            spellCheck={false}
            editable={!busy}
          />
          <View className="overflow-hidden rounded-xl">
            {PROJECT_SECRET_EXPOSURE_CHOICES.map((choice, index) => (
              <SettingsChoiceRow
                key={choice.exposeAs}
                label={choice.label}
                description={choice.description}
                selected={exposeAs === choice.exposeAs}
                separated={index > 0}
                disabled={busy}
                onPress={() => setExposeAs(choice.exposeAs)}
              />
            ))}
          </View>
          {formError !== null ? (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {formError}
            </Text>
          ) : null}
          <SettingsActionRow label="Save secret" loading={busy} onPress={() => void save()} />
          <SettingsActionRow label="Cancel" disabled={busy} onPress={closeForm} />
        </View>
      ) : (
        <View className={secrets.length > 0 ? "border-t border-border-subtle" : undefined}>
          <SettingsActionRow
            icon="plus"
            label="Add secret"
            disabled={!props.canWrite || loaded === null}
            onPress={() => setAdding(true)}
          />
        </View>
      )}
    </SettingsSection>
  );
}
