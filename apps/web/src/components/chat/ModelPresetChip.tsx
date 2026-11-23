import { useGT } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { findModelPresetByName } from "@t3tools/client-runtime/composer-model-presets";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { GitBranchIcon } from "lucide-react";

import { describeModelPreset } from "~/modelPresets";
import { brandProviderInstanceEntries, deriveProviderInstanceEntries } from "~/providerInstances";
import { serverEnvironment } from "~/state/server";
import { contextChipAccentWithHueOf } from "~/themePalette";
import { ContextChipPopover } from "../contextChipParts";
import { ProviderInstanceIcon, providerLogoColor } from "./ProviderInstanceIcon";

interface ModelPresetChipPresentation {
  readonly name: string;
  readonly summaryLabel: string;
  readonly providerLabel: string;
  readonly driverKind: ProviderDriverKind | null;
  readonly providerDisplayName: string;
  readonly acpRegistryAgentId: string | undefined;
  readonly acpRegistryIconUrl: string | undefined;
}

function presentationsEqual(left: ModelPresetChipPresentation, right: ModelPresetChipPresentation) {
  return (
    left.name === right.name &&
    left.summaryLabel === right.summaryLabel &&
    left.providerLabel === right.providerLabel &&
    left.driverKind === right.driverKind &&
    left.providerDisplayName === right.providerDisplayName &&
    left.acpRegistryAgentId === right.acpRegistryAgentId &&
    left.acpRegistryIconUrl === right.acpRegistryIconUrl
  );
}

const modelPresetChipPresentationAtom = Atom.family((key: string) =>
  Atom.make((get): ModelPresetChipPresentation | null => {
    const [environmentId, presetName] = key.split("\u0000") as [string, string];
    if (!environmentId || !presetName) return null;
    const config = get(serverEnvironment.configValueAtom(environmentId as EnvironmentId));
    if (!config) return null;
    const preset = findModelPresetByName(config.settings.modelPresets, presetName);
    if (!preset) return null;
    const entries = brandProviderInstanceEntries(
      deriveProviderInstanceEntries(config.providers),
      config.settings,
    );
    const display = describeModelPreset(preset, entries, config.providers);
    const next: ModelPresetChipPresentation = {
      name: preset.name,
      summaryLabel: display.summaryLabel,
      providerLabel: display.providerLabel,
      driverKind: display.driverKind,
      providerDisplayName: display.providerDisplayName,
      acpRegistryAgentId: display.acpRegistryAgentId,
      acpRegistryIconUrl: display.acpRegistryIconUrl,
    };
    const previous = Option.getOrNull(get.self<ModelPresetChipPresentation | null>());
    return previous && presentationsEqual(previous, next) ? previous : next;
  }).pipe(Atom.withLabel("model-preset-chip-presentation")),
);

export const modelPresetNamesAtom = Atom.family((environmentId: string) =>
  Atom.make((get): ReadonlySet<string> => {
    const config = environmentId
      ? get(serverEnvironment.configValueAtom(environmentId as EnvironmentId))
      : null;
    const next = new Set(
      (config?.settings.modelPresets ?? []).map((preset) => preset.name.toLowerCase()),
    );
    const previous = Option.getOrNull(get.self<ReadonlySet<string>>());
    return previous && previous.size === next.size && [...next].every((key) => previous.has(key))
      ? previous
      : next;
  }).pipe(Atom.withLabel("model-preset-names")),
);

function logoAccent(driverKind: ProviderDriverKind | null): string | undefined {
  if (!driverKind) return undefined;
  const color = providerLogoColor(driverKind);
  return (color && contextChipAccentWithHueOf("model", color)) || undefined;
}

export function ModelPresetChip(props: {
  environmentId: EnvironmentId | null;
  presetName: string;
  mode: "switch" | "subagent";
  source: string;
}) {
  const gt = useGT();
  const presentation = useAtomValue(
    modelPresetChipPresentationAtom(
      `${props.environmentId ?? ""}\u0000${props.presetName.toLowerCase()}`,
    ),
  );
  if (!presentation) return props.source;
  const accent = logoAccent(presentation.driverKind);
  const label = props.mode === "subagent" ? `^${presentation.name}` : `@${presentation.name}`;
  return (
    <ContextChipPopover
      kind="neutral"
      accent={accent}
      icon={
        <span className="inline-flex items-center gap-1">
          {props.mode === "subagent" ? (
            <GitBranchIcon aria-hidden="true" className="size-[0.95em]" />
          ) : null}
          {presentation.driverKind ? (
            <ProviderInstanceIcon
              driverKind={presentation.driverKind}
              displayName={presentation.providerDisplayName}
              acpRegistryAgentId={presentation.acpRegistryAgentId}
              acpRegistryIconUrl={presentation.acpRegistryIconUrl}
              className="z-auto"
              iconClassName="size-[1em]"
            />
          ) : null}
        </span>
      }
      label={label}
      accessibleLabel={
        props.mode === "subagent"
          ? gt("Subagent preset {label}", { label: presentation.name })
          : gt("Switch model preset {label}", { label: presentation.name })
      }
      copyMarkdown={props.source}
    >
      <div className="space-y-1 p-2 text-sm">
        <p className="font-medium">{presentation.name}</p>
        <p className="text-muted-foreground">{presentation.summaryLabel}</p>
        <p className="text-xs text-muted-foreground">
          {props.mode === "subagent"
            ? gt("Starts a subagent in this thread and reports back to the main agent.")
            : gt("Switches this thread's model when you send.")}
        </p>
        <p className="font-mono text-xs text-muted-foreground">{presentation.providerLabel}</p>
      </div>
    </ContextChipPopover>
  );
}
