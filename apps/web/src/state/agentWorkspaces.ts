import type { AgentWorkspaceCatalog, EnvironmentId } from "@t3tools/contracts";

import { filesystemEnvironment } from "./filesystem";
import { useEnvironmentQuery } from "./query";
import { useOrchestrationCommand } from "./use-orchestration-command";

const EMPTY_CATALOG: AgentWorkspaceCatalog = {
  workspaces: [],
  errors: [],
};

const EMPTY_LIST_INPUT = {} as const;

export function useEnvironmentAgentWorkspaces(environmentId: EnvironmentId | null) {
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : filesystemEnvironment.listAgentWorkspaces({
          environmentId,
          input: EMPTY_LIST_INPUT,
        }),
  );
  return {
    catalog: query.data ?? EMPTY_CATALOG,
    workspaces: query.data?.workspaces ?? EMPTY_CATALOG.workspaces,
    errors: query.data?.errors ?? EMPTY_CATALOG.errors,
    error: query.error,
    isPending: query.isPending,
    isSuccess: query.isSuccess,
    refresh: query.refresh,
  };
}

export function useAgentWorkspaceCommands() {
  const register = useOrchestrationCommand(filesystemEnvironment.registerAgentWorkspace, {
    reportFailure: false,
  });
  const unregister = useOrchestrationCommand(filesystemEnvironment.unregisterAgentWorkspace, {
    reportFailure: false,
  });
  return { register, unregister };
}
