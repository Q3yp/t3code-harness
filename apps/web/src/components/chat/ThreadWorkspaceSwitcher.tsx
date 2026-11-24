import {
  AuthOrchestrationOperateScope,
  type AgentWorkspaceSummary,
  type EnvironmentId,
  type ThreadActiveWorkspace,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { T, useGT } from "gt-react";
import { CheckIcon, LayersIcon, XIcon } from "lucide-react";
import { memo, useState } from "react";

import { useComposerDraftStore, type DraftId } from "~/composerDraftStore";
import { activeWorkspaceFromSummary, workspacePathsEqual } from "~/lib/agentWorkspaces";
import { cn } from "~/lib/utils";
import { useEnvironmentAgentWorkspaces } from "~/state/agentWorkspaces";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

interface ThreadWorkspaceSwitcherProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly isServerThread: boolean;
  readonly draftId?: DraftId | undefined;
  readonly activeWorkspace: ThreadActiveWorkspace | null;
}

export const ThreadWorkspaceSwitcher = memo(function ThreadWorkspaceSwitcher({
  environmentId,
  threadId,
  isServerThread,
  draftId,
  activeWorkspace,
}: ThreadWorkspaceSwitcherProps) {
  const gt = useGT();
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const { workspaces } = useEnvironmentAgentWorkspaces(environmentId);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [isUpdating, setIsUpdating] = useState(false);

  if (workspaces.length === 0 && activeWorkspace === null) {
    return null;
  }

  const disabled = (isServerThread && !canOperate) || isUpdating;

  const applyWorkspace = async (next: AgentWorkspaceSummary | null) => {
    const nextValue = next === null ? null : activeWorkspaceFromSummary(next);
    if (!isServerThread) {
      if (draftId) {
        setDraftThreadContext(draftId, { activeWorkspace: nextValue });
      }
      return;
    }
    setIsUpdating(true);
    const result = await updateThreadMetadata({
      environmentId,
      input: {
        threadId,
        activeWorkspace: nextValue,
      },
    });
    setIsUpdating(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: next ? gt("Failed to switch workspace") : gt("Failed to clear workspace"),
        description: error instanceof Error ? error.message : gt("An error occurred."),
      });
    }
  };

  const trigger = (
    <MenuTrigger disabled={disabled} render={<ThreadDetailsControl part="select" />}>
      <LayersIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
      <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
        {activeWorkspace ? activeWorkspace.name : gt("No active workspace")}
      </span>
    </MenuTrigger>
  );

  return (
    <Menu>
      {activeWorkspace ? (
        <Tooltip>
          <TooltipTrigger render={trigger} />
          <TooltipPopup side="left">
            <div className="space-y-0.5">
              <div className="font-medium">{activeWorkspace.name}</div>
              <div className="font-mono text-2xs opacity-80">{activeWorkspace.path}</div>
            </div>
          </TooltipPopup>
        </Tooltip>
      ) : (
        trigger
      )}
      <MenuPopup align="end" className="w-64">
        <MenuGroup>
          <MenuGroupLabel>
            <T>Agent Workspaces</T>
          </MenuGroupLabel>
          {workspaces.map((workspace) => {
            const isActive = workspacePathsEqual(activeWorkspace?.path, workspace.path);
            return (
              <MenuItem
                key={workspace.path}
                onClick={() => {
                  if (!isActive) void applyWorkspace(workspace);
                }}
              >
                <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-xs">{workspace.name}</div>
                  <div className="truncate text-2xs text-muted-foreground">
                    {workspace.description}
                  </div>
                </div>
                {isActive ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
              </MenuItem>
            );
          })}
        </MenuGroup>
        {activeWorkspace ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => void applyWorkspace(null)}>
              <XIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="text-xs">
                <T>Clear workspace</T>
              </span>
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
