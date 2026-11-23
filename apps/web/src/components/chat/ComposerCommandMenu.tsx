import { type AtMentionCategory } from "@t3tools/client-runtime/composer-model-presets";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import type { ComposerPathSearchTarget } from "@t3tools/client-runtime/state/threads";
import {
  resolveProviderSkillSourceKind,
  type ProviderSkillSourceKind,
} from "@t3tools/client-runtime/providerSkills";
import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ModelSelection,
  type ProjectEntry,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type PullRequestContextMetadata,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import {
  BlocksIcon,
  FolderIcon,
  GitBranchIcon,
  MessagesSquareIcon,
  PackageIcon,
  SettingsIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { msg, useGT, useMessages } from "gt-react";
import { memo, useLayoutEffect, useRef, useState } from "react";

import { type ComposerSlashCommand, type ComposerTriggerKind } from "../../composer-logic";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Command, CommandGroup, CommandGroupLabel, CommandItem, CommandList } from "../ui/command";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ComposerBanner } from "./ComposerBanner";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";

export type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      pathKind: ProjectEntry["kind"];
      searchTarget: ComposerPathSearchTarget;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "slash-command";
      command: ComposerSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "provider-slash-command";
      provider: ProviderDriverKind;
      command: ServerProviderSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "skill";
      provider: ProviderDriverKind;
      skill: ServerProviderSkill;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "pull-request";
      pullRequest: PullRequestContextMetadata;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "thread";
      thread: ScopedThreadRef;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "environment";
      environmentId: EnvironmentId;
      machine: EnvironmentMachineKind;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "model";
      instanceId: ProviderInstanceId;
      model: string;
      driverKind: ProviderDriverKind;
      providerDisplayName: string;
      acpRegistryAgentId: string | undefined;
      acpRegistryIconUrl: string | undefined;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "model-preset";
      mode: "switch" | "subagent";
      presetName: string;
      modelSelection: ModelSelection;
      driverKind: ProviderDriverKind | null;
      providerDisplayName: string;
      acpRegistryAgentId: string | undefined;
      acpRegistryIconUrl: string | undefined;
      label: string;
      description: string;
    };

const AT_CATEGORY_PILL_META: Readonly<
  Record<AtMentionCategory, { readonly label: string; readonly shortcut: string | null }>
> = {
  all: { label: msg("All"), shortcut: null },
  preset: { label: msg("Presets"), shortcut: "p:" },
  path: { label: msg("Files"), shortcut: "f:" },
  thread: { label: msg("Threads"), shortcut: "t:" },
  model: { label: msg("Models"), shortcut: "m:" },
  environment: { label: msg("Machines"), shortcut: "e:" },
};

const AT_ITEM_GROUP_LABELS: Readonly<
  Record<
    Extract<
      ComposerCommandItem["type"],
      "model-preset" | "thread" | "environment" | "model" | "path"
    >,
    string
  >
> = {
  "model-preset": msg("Model presets"),
  thread: msg("Threads"),
  environment: msg("Machines"),
  model: msg("Models"),
  path: msg("Files & folders"),
};

function groupAtMenuItems(items: ReadonlyArray<ComposerCommandItem>): ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly items: ComposerCommandItem[];
}> {
  const groups: Array<{ key: string; label: string; items: ComposerCommandItem[] }> = [];
  for (const item of items) {
    const label =
      item.type in AT_ITEM_GROUP_LABELS
        ? AT_ITEM_GROUP_LABELS[item.type as keyof typeof AT_ITEM_GROUP_LABELS]
        : null;
    const key = label ? item.type : "other";
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(item);
    } else {
      groups.push({ key, label: label ?? "", items: [item] });
    }
  }
  return groups;
}

export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  listId: string;
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  emptyStateText?: string;
  activeItemId: string | null;
  atCategory?: AtMentionCategory;
  atCategoryLocked?: boolean;
  availableAtCategories?: ReadonlyArray<AtMentionCategory>;
  onAtCategoryChange?: (category: AtMentionCategory) => void;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const listRef = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the highlighted menu item's DOM node into view
  useLayoutEffect(() => {
    if (!props.activeItemId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-composer-item-id="${CSS.escape(props.activeItemId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [props.activeItemId]);

  const showAtCategoryBar =
    props.triggerKind === "path" &&
    props.availableAtCategories !== undefined &&
    props.availableAtCategories.length > 1 &&
    props.onAtCategoryChange !== undefined;
  const groupedAtItems = props.triggerKind === "path" ? groupAtMenuItems(props.items) : null;

  return (
    <Command
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(highlightedValue) => {
        props.onHighlightedItemChange(
          typeof highlightedValue === "string" ? highlightedValue : null,
        );
      }}
    >
      <ComposerBanner.Surface
        ref={listRef}
        className="flex min-h-0 w-full flex-col overflow-hidden pb-(--chat-composer-attachment-overlap) **:data-[slot=command-item]:rounded-lg **:data-[slot=scroll-area-scrollbar]:data-[orientation=vertical]:my-4"
        data-composer-command-drawer="true"
      >
        {showAtCategoryBar ? (
          <div
            className="flex items-center gap-1 overflow-x-auto border-b border-foreground/[0.06] px-2.5 py-1.5"
            role="tablist"
            aria-label={gt("Mention categories")}
          >
            {props.availableAtCategories!.map((category) => {
              const meta = AT_CATEGORY_PILL_META[category];
              const isSelected = (props.atCategory ?? "all") === category;
              return (
                <button
                  key={category}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  disabled={props.atCategoryLocked && !isSelected}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onClick={() => {
                    props.onAtCategoryChange?.(category);
                  }}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium transition-colors",
                    isSelected
                      ? "bg-accent text-accent-foreground"
                      : "text-secondary-label hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-45",
                  )}
                >
                  <span>{m(meta.label)}</span>
                  {meta.shortcut ? (
                    <span className="font-mono text-xs opacity-65">@{meta.shortcut}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
        {props.items.length > 0 ? (
          <CommandList
            id={props.listId}
            aria-label={
              props.triggerKind ? m(LISTBOX_LABEL_BY_TRIGGER[props.triggerKind]) : undefined
            }
            className="max-h-72 min-h-0 scroll-pb-6"
          >
            {groupedAtItems ? (
              groupedAtItems.map((group) => (
                <CommandGroup key={group.key}>
                  {group.label ? <CommandGroupLabel>{m(group.label)}</CommandGroupLabel> : null}
                  {group.items.map((item) => (
                    <ComposerCommandMenuItem
                      key={item.id}
                      optionId={composerSuggestionOptionId(props.listId, item.id)}
                      item={item}
                      triggerKind={props.triggerKind}
                      resolvedTheme={props.resolvedTheme}
                      isActive={props.activeItemId === item.id}
                      onHighlight={props.onHighlightedItemChange}
                      onSelect={props.onSelect}
                    />
                  ))}
                </CommandGroup>
              ))
            ) : (
              <CommandGroup>
                {props.items.map((item) => (
                  <ComposerCommandMenuItem
                    key={item.id}
                    optionId={composerSuggestionOptionId(props.listId, item.id)}
                    item={item}
                    triggerKind={props.triggerKind}
                    resolvedTheme={props.resolvedTheme}
                    isActive={props.activeItemId === item.id}
                    onHighlight={props.onHighlightedItemChange}
                    onSelect={props.onSelect}
                  />
                ))}
              </CommandGroup>
            )}
          </CommandList>
        ) : (
          <div className="px-5 pt-3.5 pb-7">
            <p className="text-secondary-label text-xs">
              {props.isLoading
                ? props.triggerKind === "skill" || props.triggerKind === "slash-command"
                  ? gt("Searching workspace skills...")
                  : props.triggerKind === "pull-request"
                    ? gt("Finding pull request...")
                    : gt("Searching workspace files...")
                : (props.emptyStateText ??
                  (props.triggerKind === "skill"
                    ? gt("No skills found. Try / to browse provider commands.")
                    : props.triggerKind === "path"
                      ? gt("No matching items.")
                      : props.triggerKind === "subagent-preset"
                        ? gt("No matching model presets.")
                        : gt("No matching command.")))}
            </p>
          </div>
        )}
      </ComposerBanner.Surface>
    </Command>
  );
});

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  optionId: string;
  item: ComposerCommandItem;
  triggerKind: ComposerTriggerKind | null;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const m = useMessages();
  const skillSourceKind =
    props.item.type === "skill" ? resolveProviderSkillSourceKind(props.item.skill) : null;
  const isSlashSkill =
    props.triggerKind === "slash-command" && props.item.type === "skill" ? props.item.skill : null;
  const pullRequestPresentation =
    props.item.type === "pull-request" ? resolvePullRequestState(props.item.pullRequest, m) : null;
  const descriptionRef = useRef<HTMLSpanElement>(null);
  const [descriptionTruncated, setDescriptionTruncated] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the rendered description so only cut-off text gets a tooltip
  useLayoutEffect(() => {
    const description = descriptionRef.current;
    setDescriptionTruncated(
      props.isActive && !!description && description.scrollWidth > description.clientWidth,
    );
  }, [props.isActive]);

  return (
    <CommandItem
      render={<div id={props.optionId} />}
      aria-selected={props.isActive}
      value={props.item.id}
      data-composer-item-id={props.item.id}
      active={props.isActive}
      onMouseMove={() => {
        if (!props.isActive) props.onHighlight(props.item.id);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onSelect(props.item);
      }}
    >
      {props.item.type === "path" ? (
        <PierreEntryIcon
          pathValue={props.item.path}
          kind={props.item.pathKind}
          theme={props.resolvedTheme}
        />
      ) : null}
      {props.item.type === "thread" ? (
        <MessagesSquareIcon aria-hidden="true" className="size-4 shrink-0 text-secondary-label" />
      ) : null}
      {props.item.type === "environment" ? (
        <EnvironmentMachineIcon
          kind={props.item.machine}
          aria-hidden="true"
          className="size-4 shrink-0 text-secondary-label"
        />
      ) : null}
      {props.item.type === "model" ? (
        <ProviderInstanceIcon
          driverKind={props.item.driverKind}
          displayName={props.item.providerDisplayName}
          acpRegistryAgentId={props.item.acpRegistryAgentId}
          acpRegistryIconUrl={props.item.acpRegistryIconUrl}
          className="size-4 shrink-0"
          iconClassName="size-4"
        />
      ) : null}
      {props.item.type === "model-preset" ? (
        <span className="inline-flex shrink-0 items-center gap-1">
          {props.item.mode === "subagent" ? (
            <GitBranchIcon aria-hidden="true" className="size-3.5 text-secondary-label" />
          ) : null}
          {props.item.driverKind ? (
            <ProviderInstanceIcon
              driverKind={props.item.driverKind}
              displayName={props.item.providerDisplayName}
              acpRegistryAgentId={props.item.acpRegistryAgentId}
              acpRegistryIconUrl={props.item.acpRegistryIconUrl}
              className="size-4 shrink-0"
              iconClassName="size-4"
            />
          ) : null}
        </span>
      ) : null}
      {pullRequestPresentation ? (
        <pullRequestPresentation.Icon
          role="img"
          aria-label={pullRequestPresentation.label}
          className={cn("size-4 shrink-0", pullRequestPresentation.toneClassName)}
        />
      ) : null}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 max-w-[45%] shrink-0 truncate font-sans text-xs font-medium">
          {isSlashSkill ? (
            <>
              <span className="text-secondary-label">/skill:</span>
              {formatProviderSkillDisplayName(isSlashSkill)}
            </>
          ) : (
            props.item.label
          )}
        </span>
        <Tooltip open={descriptionTruncated}>
          <TooltipTrigger
            tabIndex={-1}
            render={
              <span
                ref={descriptionRef}
                className="min-w-0 flex-1 truncate text-left text-secondary-label text-xs"
              />
            }
          >
            {props.item.description}
          </TooltipTrigger>
          <TooltipPopup>{props.item.description}</TooltipPopup>
        </Tooltip>
        {skillSourceKind ? (
          <SkillSourceBadge
            kind={skillSourceKind}
            showSkillSuffix={props.triggerKind === "skill"}
          />
        ) : null}
        {props.item.type === "model-preset" ? (
          <Badge className="ms-auto" variant="secondary">
            {props.item.mode === "subagent"
              ? m(msg("Subagent", { $context: "composer preset badge" }))
              : m(msg("Switch on send", { $context: "composer preset badge" }))}
          </Badge>
        ) : null}
      </span>
    </CommandItem>
  );
});

export function composerSuggestionOptionId(listId: string, itemId: string): string {
  // JSON escapes lone UTF-16 surrogates before URI encoding without losing identity.
  return `${listId}-${encodeURIComponent(JSON.stringify(itemId))}`;
}

const LISTBOX_LABEL_BY_TRIGGER: Record<ComposerTriggerKind, string> = {
  path: msg("Mentions"),
  "pull-request": msg("Pull requests"),
  "slash-command": msg("Commands"),
  skill: msg("Skills"),
  "subagent-preset": msg("Subagent presets"),
};

const SKILL_SOURCE_ICON_BY_KIND: Record<ProviderSkillSourceKind, LucideIcon> = {
  app: BlocksIcon,
  repo: FolderIcon,
  project: FolderIcon,
  personal: UserRoundIcon,
  system: SettingsIcon,
  other: PackageIcon,
};

const SKILL_SOURCE_LABEL_BY_KIND: Record<
  ProviderSkillSourceKind,
  { readonly label: string; readonly skillLabel: string }
> = {
  app: {
    label: msg("App", { $context: "skill source badge" }),
    skillLabel: msg("App Skill"),
  },
  repo: {
    label: msg("Repo", { $context: "skill source badge" }),
    skillLabel: msg("Repo Skill"),
  },
  project: {
    label: msg("Project", { $context: "skill source badge" }),
    skillLabel: msg("Project Skill"),
  },
  personal: {
    label: msg("Personal", { $context: "skill source badge" }),
    skillLabel: msg("Personal Skill"),
  },
  system: {
    label: msg("System", { $context: "skill source badge" }),
    skillLabel: msg("System Skill"),
  },
  other: {
    label: msg("Provider", { $context: "skill source badge" }),
    skillLabel: msg("Provider Skill"),
  },
};

function SkillSourceBadge(props: { kind: ProviderSkillSourceKind; showSkillSuffix: boolean }) {
  const m = useMessages();
  const Icon = SKILL_SOURCE_ICON_BY_KIND[props.kind];
  const labels = SKILL_SOURCE_LABEL_BY_KIND[props.kind];
  return (
    <Badge className="ms-auto" variant="secondary">
      <Icon aria-hidden="true" className="text-current" />
      {m(props.showSkillSuffix ? labels.skillLabel : labels.label)}
    </Badge>
  );
}
