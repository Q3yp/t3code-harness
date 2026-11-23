import {
  type EnvironmentId,
  MAX_MODEL_PRESETS,
  MODEL_PRESET_NAME_PATTERN,
  type ModelPreset,
  ModelPresetName,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection, pickModelSelection } from "@t3tools/shared/model";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { T, useGT } from "gt-react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { describeModelPreset } from "../../modelPresets";
import { isProviderInstancePickerReady, providerInstanceEntriesFor } from "../../providerInstances";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
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
import { Label } from "../ui/label";
import { useSearchableSetting } from "./settingsSearch";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";

interface EditingPresetState {
  /** Original lowercase name when editing an existing preset; null when creating a new one. */
  readonly originalNameLower: string | null;
  readonly name: string;
  readonly modelSelection: ModelSelection;
}

export function ModelPresetsSettings({
  environmentId,
  providers,
  canWriteSettings,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly canWriteSettings: boolean;
}) {
  const setting = useSearchableSetting();
  const gt = useGT();
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [editing, setEditing] = useState<EditingPresetState | null>(null);

  const presets = settings.modelPresets;
  const entries = providerInstanceEntriesFor(providers, settings, null);
  const defaultEntry =
    entries.find((entry) => isProviderInstancePickerReady(entry) && entry.models.length > 0) ??
    entries.find((entry) => entry.models.length > 0) ??
    null;

  const initialSelectionForNew = (): ModelSelection | null => {
    if (settings.defaultModelSelection) return settings.defaultModelSelection;
    if (!defaultEntry) return null;
    const firstModel = defaultEntry.models[0];
    if (!firstModel) return null;
    return createModelSelection(defaultEntry.instanceId, firstModel.slug);
  };

  const openNewDialog = () => {
    const fallback = initialSelectionForNew();
    if (!fallback) return;
    setEditing({
      originalNameLower: null,
      name: "",
      modelSelection: fallback,
    });
  };

  const openEditDialog = (preset: ModelPreset) => {
    setEditing({
      originalNameLower: preset.name.toLowerCase(),
      name: preset.name,
      modelSelection: preset.modelSelection,
    });
  };

  const removePreset = (nameLower: string) => {
    updateSettings({
      modelPresets: presets.filter((preset) => preset.name.toLowerCase() !== nameLower),
    });
  };

  const editingTrimmedName = editing?.name.trim() ?? "";
  const editingNameError = (() => {
    if (!editing) return null;
    if (editingTrimmedName.length === 0) return null;
    if (editingTrimmedName.length > 64) return gt("Name must be 64 characters or fewer.");
    if (!MODEL_PRESET_NAME_PATTERN.test(editingTrimmedName)) {
      return gt("Use a single token without spaces or @ # ^ / $ : punctuation.");
    }
    const lower = editingTrimmedName.toLowerCase();
    const duplicate = presets.some(
      (preset) => preset.name.toLowerCase() === lower && lower !== editing.originalNameLower,
    );
    if (duplicate) return gt("A preset with this name already exists.");
    return null;
  })();

  const canSaveEditing =
    editing !== null && editingTrimmedName.length > 0 && editingNameError === null;

  const saveEditing = () => {
    if (!editing || !canSaveEditing) return;
    const nextPreset: ModelPreset = {
      name: ModelPresetName.make(editingTrimmedName),
      modelSelection: editing.modelSelection,
    };
    const nextPresets =
      editing.originalNameLower === null
        ? [...presets, nextPreset]
        : presets.map((preset) =>
            preset.name.toLowerCase() === editing.originalNameLower ? nextPreset : preset,
          );
    updateSettings({ modelPresets: nextPresets });
    setEditing(null);
  };

  const editingEntry = editing
    ? entries.find((entry) => entry.instanceId === editing.modelSelection.instanceId)
    : undefined;
  const editingModelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    editing?.modelSelection.instanceId,
    editing?.modelSelection.model,
  );
  const canAddPreset =
    canWriteSettings && presets.length < MAX_MODEL_PRESETS && initialSelectionForNew() !== null;

  return (
    <>
      <SettingsSection
        {...setting("model-presets")}
        headerAction={
          canWriteSettings ? (
            <Button size="xs" variant="outline" disabled={!canAddPreset} onClick={openNewDialog}>
              <PlusIcon className="size-3" aria-hidden />
              <T>Add preset</T>
            </Button>
          ) : null
        }
      >
        {presets.length === 0 ? (
          <SettingsRow
            title={gt("No model presets yet")}
            description={gt(
              "Name a model and reasoning effort combination to switch models on send with @name, or launch a subagent with ^name message.",
            )}
          />
        ) : (
          presets.map((preset) => {
            const display = describeModelPreset(preset, entries, providers);
            return (
              <SettingsRow
                key={preset.name.toLowerCase()}
                title={
                  <span className="inline-flex min-w-0 items-center gap-2">
                    {display.driverKind ? (
                      <ProviderInstanceIcon
                        driverKind={display.driverKind}
                        displayName={display.providerDisplayName}
                        acpRegistryAgentId={display.acpRegistryAgentId}
                        acpRegistryIconUrl={display.acpRegistryIconUrl}
                        badgeContent="none"
                      />
                    ) : null}
                    <span className="truncate font-medium">{preset.name}</span>
                    <Badge variant="outline" size="sm">
                      <span className="font-mono">@{preset.name}</span>
                    </Badge>
                    <Badge variant="outline" size="sm">
                      <span className="font-mono">^{preset.name}</span>
                    </Badge>
                  </span>
                }
                description={
                  <span className="block truncate">
                    {display.summaryLabel} · {display.providerLabel}
                  </span>
                }
                control={
                  canWriteSettings ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={gt("Edit preset {name}", { name: preset.name })}
                        onClick={() => openEditDialog(preset)}
                      >
                        <PencilIcon className="size-3.5" aria-hidden />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={gt("Remove preset {name}", { name: preset.name })}
                        onClick={() => removePreset(preset.name.toLowerCase())}
                      >
                        <Trash2Icon className="size-3.5" aria-hidden />
                      </Button>
                    </div>
                  ) : null
                }
              />
            );
          })
        )}
      </SettingsSection>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {editing?.originalNameLower === null ? (
                <T>Add model preset</T>
              ) : (
                <T>Edit model preset</T>
              )}
            </DialogTitle>
            <DialogDescription>
              <T>
                Use @name in the composer to switch models when sending, or start a message with
                ^name to run a subagent that reports back to the main agent.
              </T>
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <DialogPanel>
              <div className="space-y-1.5">
                <Label htmlFor="model-preset-name-input">
                  <T>Preset name</T>
                </Label>
                <Input
                  id="model-preset-name-input"
                  value={editing.name}
                  placeholder={gt("e.g. opus-max, codex-high")}
                  onChange={(event) => {
                    const nextName = event.target.value;
                    setEditing((current) => (current ? { ...current, name: nextName } : null));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && canSaveEditing) {
                      event.preventDefault();
                      saveEditing();
                    }
                  }}
                  autoFocus
                />
                {editingNameError ? (
                  <p className="text-xs text-destructive">{editingNameError}</p>
                ) : editingTrimmedName ? (
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-xs text-muted-foreground">
                    <span>
                      <T>Triggers:</T>
                    </span>
                    <Badge variant="outline" size="sm">
                      <span className="font-mono">@{editingTrimmedName}</span>
                    </Badge>
                    <Badge variant="outline" size="sm">
                      <span className="font-mono">^{editingTrimmedName}</span>
                    </Badge>
                  </div>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <Label>
                  <T>Model and reasoning effort</T>
                </Label>
                <div className="flex flex-wrap items-center gap-2">
                  <ProviderModelPicker
                    environmentId={environmentId}
                    activeInstanceId={editing.modelSelection.instanceId}
                    model={editing.modelSelection.model}
                    lockedProvider={null}
                    instanceEntries={entries}
                    modelOptionsByInstance={editingModelOptions}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onInstanceModelChange={(instanceId, model) => {
                      setEditing((current) =>
                        current
                          ? {
                              ...current,
                              modelSelection: pickModelSelection(
                                current.modelSelection,
                                instanceId,
                                model,
                              ),
                            }
                          : null,
                      );
                    }}
                  />
                  {editingEntry ? (
                    <TraitsPicker
                      provider={editingEntry.driverKind}
                      models={editingEntry.models}
                      model={editing.modelSelection.model}
                      modelOptions={editing.modelSelection.options ?? []}
                      allowPromptInjectedEffort={false}
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      onModelOptionsChange={(options) => {
                        setEditing((current) =>
                          current
                            ? {
                                ...current,
                                modelSelection: createModelSelection(
                                  current.modelSelection.instanceId,
                                  current.modelSelection.model,
                                  options,
                                ),
                              }
                            : null,
                        );
                      }}
                    />
                  ) : null}
                </div>
              </div>
            </DialogPanel>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              <T>Cancel</T>
            </Button>
            <Button disabled={!canSaveEditing} onClick={saveEditing}>
              <T>Save preset</T>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
