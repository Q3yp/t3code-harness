import { RegistryContext } from "@effect/atom-react";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { availableMasterWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import { isMasterProject } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { msg } from "gt-react";
import { useContext, useState } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import { selectCanonicalMasterThread, selectMasterDerivedThreads } from "~/lib/chatThreadActions";
import { useProjects, useQuietThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useNewThreadHandler } from "./useHandleNewThread";

export function useMasterAssistant() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const threads = useQuietThreadShells();
  const registry = useContext(RegistryContext);
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();
  const [isOpening, setIsOpening] = useState(false);

  const masterWorkspaceRootFor = (environmentId: EnvironmentId | null): string | null => {
    if (environmentId === null) return null;
    const entry = environments.find((candidate) => candidate.environmentId === environmentId);
    return availableMasterWorkspaceRoot(entry?.connection.phase, entry?.serverConfig);
  };

  const masterEnvironmentId: EnvironmentId | null = (() => {
    if (primaryEnvironmentId !== null && masterWorkspaceRootFor(primaryEnvironmentId) !== null) {
      return primaryEnvironmentId;
    }
    const offering = environments.filter(
      (entry) => availableMasterWorkspaceRoot(entry.connection.phase, entry.serverConfig) !== null,
    );
    return offering[0]?.environmentId ?? null;
  })();

  const masterWorkspaceRoot = masterWorkspaceRootFor(masterEnvironmentId);

  const masterProjectKeys = new Set<string>();
  let masterProject: EnvironmentProject | null = null;
  for (const project of projects) {
    const root = masterWorkspaceRootFor(project.environmentId);
    if (isMasterProject(project, root)) {
      masterProjectKeys.add(`${project.environmentId}:${project.id}`);
      if (project.environmentId === masterEnvironmentId && masterProject === null) {
        masterProject = project;
      }
    }
  }

  const masterThread: EnvironmentThreadShell | null = selectCanonicalMasterThread(
    threads,
    masterProject,
  );
  const masterThreadKey: string | null =
    masterThread === null
      ? null
      : scopedThreadKey(scopeThreadRef(masterThread.environmentId, masterThread.id));
  const masterDerivedThreads = selectMasterDerivedThreads(threads, {
    masterProjectKeys,
    masterThreadKey,
  });

  const openMaster = async (): Promise<void> => {
    if (masterEnvironmentId === null || isOpening) return;
    if (masterThread !== null) {
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(masterThread.environmentId, masterThread.id)),
      });
      return;
    }
    setIsOpening(true);
    try {
      let targetProject = masterProject;
      if (targetProject === null) {
        const command = projectEnvironment.openMaster;
        const result = await runAtomCommand(
          registry,
          command,
          { environmentId: masterEnvironmentId, input: {} },
          { label: command.label, reportFailure: false, reportDefect: true },
        );
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: m(msg("Could not open Master")),
                description:
                  thrownErrorMessage(squashAtomCommandFailure(result), m) ??
                  m(msg("An error occurred.")),
              }),
            );
          }
          return;
        }
        targetProject = result.value;
      }
      await handleNewThread(scopeProjectRef(targetProject.environmentId, targetProject.id), {
        activeWorkspace: null,
        envMode: "local",
      });
    } finally {
      setIsOpening(false);
    }
  };

  return {
    masterEnvironmentId,
    masterWorkspaceRoot,
    masterProject,
    masterProjectKeys,
    masterThread,
    masterThreadKey,
    masterDerivedThreads,
    isOpening,
    openMaster,
  };
}
