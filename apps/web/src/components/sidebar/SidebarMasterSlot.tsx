import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { BotIcon, ChevronDownIcon, ChevronRightIcon, LayersIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import { hasUnseenCompletion } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

interface SidebarMasterSlotProps {
  readonly masterWorkspaceRoot: string | null;
  readonly masterThread: EnvironmentThreadShell | null;
  readonly masterThreadKey: string | null;
  readonly derivedThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly routeRowThreadKey: string | null;
  readonly isMasterDraftRouteActive: boolean;
  readonly isOpening: boolean;
  readonly projectByKey: ReadonlyMap<string, EnvironmentProject>;
  readonly projectDisplayNameByKey: ReadonlyMap<string, string>;
  readonly onOpenMaster: () => void;
  readonly onSelectDerivedThread: (threadRef: ScopedThreadRef) => void;
}

export function SidebarMasterSlot({
  masterWorkspaceRoot,
  masterThread,
  masterThreadKey,
  derivedThreads,
  routeRowThreadKey,
  isMasterDraftRouteActive,
  isOpening,
  projectByKey,
  projectDisplayNameByKey,
  onOpenMaster,
  onSelectDerivedThread,
}: SidebarMasterSlotProps) {
  const gt = useGT();
  const [toggleOverride, setToggleOverride] = useState<{
    readonly scope: "master" | "other";
    readonly expanded: boolean;
  } | null>(null);

  const isMasterRouteActive =
    (masterThreadKey !== null && routeRowThreadKey === masterThreadKey) || isMasterDraftRouteActive;
  const focusScope = isMasterRouteActive ? "master" : "other";
  const isExpanded =
    toggleOverride !== null && toggleOverride.scope === focusScope
      ? toggleOverride.expanded
      : isMasterRouteActive;

  const masterWorking = masterThread !== null && isThreadWorking(masterThread);
  const masterUnread =
    masterThread !== null && !isMasterRouteActive && hasUnseenCompletion(masterThread);

  let workingCount = 0;
  let attentionCount = 0;
  for (const thread of derivedThreads) {
    if (isThreadWorking(thread)) {
      workingCount += 1;
    } else if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
      attentionCount += 1;
    }
  }

  return (
    <div className="mt-1.5">
      <TooltipProvider delay={300}>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-testid="sidebar-master-slot"
                disabled={isOpening}
                onClick={onOpenMaster}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium transition-colors",
                  isMasterRouteActive
                    ? "bg-sidebar-row-active text-sidebar-foreground"
                    : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                )}
              >
                <BotIcon
                  className={cn(
                    "size-3.5 shrink-0",
                    masterWorking || isMasterRouteActive
                      ? "text-primary"
                      : "text-sidebar-muted-foreground",
                  )}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate">{gt("Master")}</span>
                {masterWorking ? (
                  <span className="shrink-0 text-2xs text-primary">
                    <T>Working</T>
                  </span>
                ) : masterUnread ? (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-primary"
                    aria-label={gt("Unread")}
                  />
                ) : null}
              </button>
            }
          />
          {masterWorkspaceRoot ? (
            <TooltipPopup side="right">
              <div className="space-y-0.5">
                <div className="font-medium">
                  <T>Master Assistant</T>
                </div>
                <div className="font-mono text-2xs opacity-80">{masterWorkspaceRoot}</div>
              </div>
            </TooltipPopup>
          ) : null}
        </Tooltip>
      </TooltipProvider>

      {derivedThreads.length > 0 ? (
        <div className="mt-0.5">
          <button
            type="button"
            data-testid="sidebar-master-status-bar"
            aria-expanded={isExpanded}
            onClick={() =>
              setToggleOverride({
                scope: focusScope,
                expanded: !isExpanded,
              })
            }
            className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-0.5 text-left text-2xs text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
          >
            <span className="flex min-w-0 flex-1 items-center gap-2 truncate tabular-nums">
              {workingCount > 0 ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-primary">
                  <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                  <span>{gt("{count} working", { count: workingCount })}</span>
                </span>
              ) : null}
              {attentionCount > 0 ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-warning">
                  <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
                  <span>{gt("{count} waiting", { count: attentionCount })}</span>
                </span>
              ) : null}
              <span className="truncate opacity-80">
                {gt("{count, plural, one {{count} session} other {{count} sessions}}", {
                  count: derivedThreads.length,
                })}
              </span>
            </span>
            {isExpanded ? (
              <ChevronDownIcon className="size-3 shrink-0 opacity-60" aria-hidden />
            ) : (
              <ChevronRightIcon className="size-3 shrink-0 opacity-60" aria-hidden />
            )}
          </button>

          {isExpanded ? (
            <ul
              data-testid="sidebar-master-sessions"
              className="mt-0.5 ml-3 max-h-48 space-y-0.5 overflow-y-auto border-l border-sidebar-border/60 pl-2"
            >
              {derivedThreads.map((thread) => {
                const threadRef = scopeThreadRef(thread.environmentId, thread.id);
                const rowKey = scopedThreadKey(threadRef);
                const isRowActive = routeRowThreadKey === rowKey;
                const working = isThreadWorking(thread);
                const needsAttention =
                  !working && (thread.hasPendingApprovals || thread.hasPendingUserInput);
                const unread =
                  !working && !needsAttention && !isRowActive && hasUnseenCompletion(thread);
                const projectKey = `${thread.environmentId}:${thread.projectId}`;
                const project = projectByKey.get(projectKey) ?? null;
                const targetLabel =
                  thread.activeWorkspace?.name ??
                  (project && !project.isMaster
                    ? (projectDisplayNameByKey.get(projectKey) ?? project.title)
                    : null);
                return (
                  <li key={rowKey}>
                    <button
                      type="button"
                      onClick={() => onSelectDerivedThread(threadRef)}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors",
                        isRowActive
                          ? "bg-sidebar-row-active text-sidebar-foreground"
                          : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                      )}
                    >
                      {thread.activeWorkspace ? (
                        <LayersIcon className="size-3 shrink-0 text-primary" aria-hidden />
                      ) : project && !project.isMaster ? (
                        <ProjectFavicon project={project} className="size-3 shrink-0" />
                      ) : (
                        <BotIcon className="size-3 shrink-0 opacity-60" aria-hidden />
                      )}
                      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                      {targetLabel ? (
                        <span className="max-w-16 shrink-0 truncate text-2xs opacity-60">
                          {targetLabel}
                        </span>
                      ) : null}
                      {working ? (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-primary"
                          aria-label={gt("Working")}
                        />
                      ) : needsAttention ? (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-warning"
                          aria-label={gt("Waiting")}
                        />
                      ) : unread ? (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-primary/75"
                          aria-label={gt("Unread")}
                        />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
