import { rankComposerModelMentions } from "@t3tools/client-runtime/composer-model-mentions";
import { rankComposerModelPresets } from "@t3tools/client-runtime/composer-model-presets";
import type { ModelPreset, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

import { describeModelPreset } from "../../modelPresets";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { getDisplayModelName, type ModelEsque } from "./providerIconUtils";

type ComposerModelItem = Extract<ComposerCommandItem, { type: "model" }>;
type ComposerModelPresetItem = Extract<ComposerCommandItem, { type: "model-preset" }>;

export function matchComposerModelItems(input: {
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly query: string;
  readonly allowEmptyQuery?: boolean;
}): ComposerModelItem[] {
  const candidates: Array<{ entry: ProviderInstanceEntry; option: ModelEsque }> = [];
  for (const entry of input.instanceEntries) {
    if (!isProviderInstancePickerReady(entry)) continue;
    for (const option of input.modelOptionsByInstance.get(entry.instanceId) ?? []) {
      // The picker hides legacy models by default; skip them so they don't fill the result cap.
      if (option.isLegacy || option.isUnavailable) continue;
      candidates.push({ entry, option });
    }
  }

  return rankComposerModelMentions(
    candidates,
    input.query,
    ({ entry, option }) => ({
      name: option.name,
      ...(option.shortName ? { shortName: option.shortName } : {}),
      ...(option.subProvider ? { subProvider: option.subProvider } : {}),
      driverKind: entry.driverKind,
      providerDisplayName: entry.displayName,
    }),
    input.allowEmptyQuery === true ? { allowEmptyQuery: true } : undefined,
  ).map(({ entry, option }) => ({
    id: `model:${entry.instanceId}:${option.slug}`,
    type: "model",
    instanceId: entry.instanceId,
    model: option.slug,
    driverKind: entry.driverKind,
    providerDisplayName: entry.displayName,
    acpRegistryAgentId: entry.acpRegistryAgentId,
    acpRegistryIconUrl: entry.acpRegistryIconUrl,
    label: getDisplayModelName(option),
    description: option.subProvider ?? entry.displayName,
  }));
}

export function matchComposerModelPresetItems(input: {
  readonly presets: ReadonlyArray<ModelPreset>;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly query: string;
  readonly mode: "switch" | "subagent";
  readonly limit?: number;
}): ComposerModelPresetItem[] {
  if (input.presets.length === 0) return [];
  const described = input.presets.map((preset) =>
    describeModelPreset(preset, input.instanceEntries, input.providers),
  );
  return rankComposerModelPresets(
    described,
    input.query,
    (display) => ({
      name: display.preset.name,
      searchText: `${display.summaryLabel} ${display.providerLabel} ${display.preset.modelSelection.model}`,
    }),
    input.limit,
  ).map((display) => ({
    id: `model-preset:${input.mode}:${display.preset.name.toLowerCase()}`,
    type: "model-preset",
    mode: input.mode,
    presetName: display.preset.name,
    modelSelection: display.preset.modelSelection,
    driverKind: display.driverKind,
    providerDisplayName: display.providerDisplayName,
    acpRegistryAgentId: display.acpRegistryAgentId,
    acpRegistryIconUrl: display.acpRegistryIconUrl,
    label: input.mode === "subagent" ? `^${display.preset.name}` : `@${display.preset.name}`,
    description: `${display.summaryLabel} · ${display.providerLabel}`,
  }));
}
