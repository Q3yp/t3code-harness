import {
  AuthSettingsWriteScope,
  type AgentWorkspaceSummary,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { T, useGT } from "gt-react";
import {
  AlertTriangleIcon,
  FolderOpenIcon,
  LayersIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { readLocalApi } from "~/localApi";
import { useAgentWorkspaceCommands, useEnvironmentAgentWorkspaces } from "~/state/agentWorkspaces";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentScope } from "~/state/session";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

function EnvironmentWorkspacesSection({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const gt = useGT();
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const { workspaces, errors, error, isPending, refresh } =
    useEnvironmentAgentWorkspaces(environmentId);
  const { register, unregister } = useAgentWorkspaceCommands();
  const [pathInput, setPathInput] = useState("");
  const [isMutating, setIsMutating] = useState(false);

  const handleBrowse = async () => {
    const api = readLocalApi();
    if (!api) return;
    const picked = await api.dialogs.pickFolder();
    if (picked) {
      setPathInput(picked);
    }
  };

  const handleRegister = async (targetPath: string) => {
    const trimmed = targetPath.trim();
    if (!trimmed) return;
    setIsMutating(true);
    const result = await register({
      environmentId,
      input: { path: trimmed },
    });
    setIsMutating(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const err = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Failed to register workspace"),
        description: err instanceof Error ? err.message : gt("An error occurred."),
      });
      return;
    }
    setPathInput("");
    refresh();
    toastManager.add({
      type: "success",
      title: gt("Workspace registered"),
      description: result.value.workspace.name,
    });
  };

  const handleUnregister = async (workspace: AgentWorkspaceSummary) => {
    setIsMutating(true);
    const result = await unregister({
      environmentId,
      input: { path: workspace.path },
    });
    setIsMutating(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const err = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Failed to remove workspace"),
        description: err instanceof Error ? err.message : gt("An error occurred."),
      });
      return;
    }
    refresh();
  };

  const canBrowseLocal = readLocalApi() !== null;

  return (
    <SettingsSection id={`agent-workspaces-${environmentId}`} title={environmentLabel}>
      <SettingsRow
        title={gt("Register workspace folder")}
        description={gt(
          "Add an absolute folder path containing a top-level AGENTS.md with YAML name and description frontmatter. Removing a workspace never deletes files.",
        )}
        control={
          <Button
            size="xs"
            variant="ghost"
            disabled={isPending}
            onClick={refresh}
            aria-label={gt("Refresh workspaces")}
          >
            <RefreshCwIcon className="size-3.5" />
            <span>
              <T>Refresh</T>
            </span>
          </Button>
        }
      >
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && pathInput.trim().length > 0 && canWrite && !isMutating) {
                event.preventDefault();
                void handleRegister(pathInput);
              }
            }}
            placeholder={gt("/absolute/path/to/workspace")}
            disabled={!canWrite || isMutating}
            className="min-w-60 flex-1"
          />
          {canBrowseLocal ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!canWrite || isMutating}
              onClick={() => void handleBrowse()}
            >
              <FolderOpenIcon className="size-3.5" />
              <span>
                <T>Browse</T>
              </span>
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={!canWrite || isMutating || pathInput.trim().length === 0}
            onClick={() => void handleRegister(pathInput)}
          >
            <PlusIcon className="size-3.5" />
            <span>
              <T>Register</T>
            </span>
          </Button>
        </div>
      </SettingsRow>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {errors.length > 0 ? (
        <div className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2.5 text-xs">
          <div className="mb-1 flex items-center gap-1.5 font-medium text-warning">
            <AlertTriangleIcon className="size-3.5 shrink-0" />
            <span>
              <T>Registration errors</T>
            </span>
          </div>
          <ul className="space-y-1 text-muted-foreground">
            {errors.map((entry) => (
              <li key={entry} className="break-all font-mono text-2xs">
                {entry}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {workspaces.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
          <T>No workspaces registered in this environment yet.</T>
        </div>
      ) : (
        <div className="divide-y divide-border/60 rounded-lg border border-border/70">
          {workspaces.map((workspace) => (
            <div
              key={workspace.path}
              className="flex items-start justify-between gap-3 px-3.5 py-3"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex items-center gap-1.5">
                  <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium text-sm text-foreground">
                    {workspace.name}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{workspace.description}</p>
                <p className="truncate font-mono text-2xs text-muted-foreground/80">
                  {workspace.path}
                </p>
              </div>
              <Button
                size="xs"
                variant="ghost"
                disabled={!canWrite || isMutating}
                aria-label={gt("Remove workspace {name}", { name: workspace.name })}
                onClick={() => void handleUnregister(workspace)}
              >
                <Trash2Icon className="size-3.5" />
                <span>
                  <T>Remove</T>
                </span>
              </Button>
            </div>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}

export function WorkspacesSettingsPanel() {
  const gt = useGT();
  const { scope, connectedEnvironments } = useSettingsScope();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const targetEnvironments =
    scope.kind === "environment"
      ? environments.filter(
          (environment) =>
            environment.environmentId === scope.environmentId &&
            environment.connection.phase === "connected",
        )
      : connectedEnvironments.length > 0
        ? connectedEnvironments
        : environments.filter(
            (environment) =>
              environment.environmentId === primaryEnvironmentId &&
              environment.connection.phase === "connected",
          );

  return (
    <SettingsPageContainer>
      <div className="mb-4 text-sm text-muted-foreground">
        <T>
          Agent Workspaces give a body of work a stable folder and live AGENTS.md instructions that
          agents can discover and activate from any thread, separate from skills.
        </T>
      </div>
      {targetEnvironments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {gt("Connect an environment to manage its workspaces.")}
        </p>
      ) : (
        targetEnvironments.map((environment) => (
          <EnvironmentWorkspacesSection
            key={environment.environmentId}
            environmentId={environment.environmentId}
            environmentLabel={environment.label}
          />
        ))
      )}
    </SettingsPageContainer>
  );
}
