import type {
  ModelPreset,
  ModelSelection,
  ProviderDriverKind,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { getProviderOptionCurrentLabel, getProviderOptionDescriptors } from "@t3tools/shared/model";

import { getProviderModelCapabilities } from "./providerModels";
import type { ProviderInstanceEntry } from "./providerInstances";
import { getDisplayModelName } from "./components/chat/providerIconUtils";

export interface ModelPresetDisplay {
  readonly preset: ModelPreset;
  readonly modelLabel: string;
  readonly optionsLabel: string | null;
  readonly summaryLabel: string;
  readonly providerLabel: string;
  readonly driverKind: ProviderDriverKind | null;
  readonly providerDisplayName: string;
  readonly acpRegistryAgentId: string | undefined;
  readonly acpRegistryIconUrl: string | undefined;
}

function formatModelSelectionOptionsSummary(
  driverKind: ProviderDriverKind | null,
  models: ReadonlyArray<ServerProviderModel>,
  selection: ModelSelection,
): string | null {
  const options = selection.options;
  if (!options || options.length === 0) return null;

  const capabilities =
    driverKind === null ? null : getProviderModelCapabilities(models, selection.model, driverKind);
  const descriptors = capabilities
    ? getProviderOptionDescriptors({ caps: capabilities, selections: options })
    : [];

  const labels: string[] = [];
  for (const selected of options) {
    const descriptor = descriptors.find((candidate) => candidate.id === selected.id);
    if (descriptor) {
      if (descriptor.type === "boolean") {
        if (selected.value === true) labels.push(descriptor.label);
      } else {
        const currentLabel = getProviderOptionCurrentLabel(descriptor);
        if (currentLabel) labels.push(currentLabel);
      }
      continue;
    }
    if (typeof selected.value === "boolean") {
      if (selected.value) labels.push(selected.id);
    } else if (selected.value.trim().length > 0) {
      labels.push(selected.value);
    }
  }
  return labels.length > 0 ? labels.join(" · ") : null;
}

export function describeModelPreset(
  preset: ModelPreset,
  entries: ReadonlyArray<ProviderInstanceEntry>,
  providers: ReadonlyArray<ServerProvider>,
): ModelPresetDisplay {
  const entry = entries.find(
    (candidate) => candidate.instanceId === preset.modelSelection.instanceId,
  );
  const provider = providers.find(
    (candidate) => candidate.instanceId === preset.modelSelection.instanceId,
  );
  const models = entry?.models ?? provider?.models ?? [];
  const option = models.find((candidate) => candidate.slug === preset.modelSelection.model);
  const modelLabel = option ? getDisplayModelName(option) : preset.modelSelection.model;
  const driverKind = entry?.driverKind ?? provider?.driver ?? null;
  const optionsLabel = formatModelSelectionOptionsSummary(
    driverKind,
    models,
    preset.modelSelection,
  );
  const summaryLabel = optionsLabel ? `${modelLabel} · ${optionsLabel}` : modelLabel;
  const providerDisplayName =
    entry?.displayName ?? provider?.displayName ?? String(preset.modelSelection.instanceId);
  return {
    preset,
    modelLabel,
    optionsLabel,
    summaryLabel,
    providerLabel: option?.subProvider ?? providerDisplayName,
    driverKind,
    providerDisplayName,
    acpRegistryAgentId: entry?.acpRegistryAgentId,
    acpRegistryIconUrl: entry?.acpRegistryIconUrl,
  };
}
