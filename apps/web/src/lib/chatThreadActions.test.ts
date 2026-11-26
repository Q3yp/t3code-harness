import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  resolveNewThreadModelSelectionOverride,
  resolveThreadActionProjectRef,
  selectCanonicalMasterThread,
  selectMasterDerivedThreads,
  startNewThreadFromContext,
} from "./chatThreadActions";

const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "carried-model",
};

describe("chatThreadActions", () => {
  it("does not carry a non-explicit model from the destination draft back into itself", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-a",
      }),
    ).toBeNull();
  });

  it("keeps the project default above any carried selection", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });

  it("keeps the oldest user thread as canonical Master over a newer MCP thread", () => {
    const environmentId = EnvironmentId.make("env-local");
    const masterProjectId = ProjectId.make("project-master");
    const canonical = {
      environmentId,
      id: ThreadId.make("38338abe-4bc0-4340-bff5-ba42c445a870"),
      projectId: masterProjectId,
      createdAt: "2026-11-25T01:44:34.550Z",
      updatedAt: "2026-11-25T02:09:07.564Z",
      deletedAt: null,
      archivedAt: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: ThreadId.make("38338abe-4bc0-4340-bff5-ba42c445a870"),
      },
    };
    const mcpSpawned = {
      environmentId,
      id: ThreadId.make("thread:mcp:session:req:0"),
      projectId: masterProjectId,
      createdAt: "2026-11-25T02:08:50.484Z",
      updatedAt: "2026-11-25T02:14:10.303Z",
      deletedAt: null,
      archivedAt: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: ThreadId.make("thread:mcp:session:req:0"),
      },
    };

    expect(
      selectCanonicalMasterThread([mcpSpawned, canonical], {
        environmentId,
        id: masterProjectId,
      })?.id,
    ).toBe(canonical.id);
  });

  it("falls back to defaultProjectRef instead of creating a new thread in Master", async () => {
    const environmentId = EnvironmentId.make("env-local");
    const masterProjectId = ProjectId.make("project-master");
    const defaultProjectRef = scopeProjectRef(environmentId, ProjectId.make("project-app"));
    const handleNewThread = vi.fn(async () => null);
    const context = {
      activeDraftThread: null,
      activeThread: {
        environmentId,
        projectId: masterProjectId,
      },
      activeProjectIsMaster: true,
      defaultProjectRef,
      handleNewThread,
    };

    expect(resolveThreadActionProjectRef(context)).toEqual(defaultProjectRef);
    expect(await startNewThreadFromContext(context)).toBe(true);
    expect(handleNewThread).toHaveBeenCalledExactlyOnceWith(defaultProjectRef);
  });

  it("selects active Master-derived threads sorted by working, waiting, then recency", () => {
    const environmentId = EnvironmentId.make("env-local");
    const masterProjectId = ProjectId.make("project-master");
    const appProjectId = ProjectId.make("project-app");
    const masterId = ThreadId.make("thread-master");
    const base = {
      environmentId,
      deletedAt: null,
      archivedAt: null,
      settledOverride: null as "settled" | "active" | null,
      settledAt: null as string | null,
      runtime: null as { status: "running" | "idle" } | null,
      latestRun: null,
      interactionMode: "default" as const,
      hasActionableProposedPlan: false,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      pendingSubagentRequest: null,
    };
    const makeThread = (
      id: string,
      overrides: Partial<typeof base> & {
        projectId: ProjectId;
        createdAt: string;
        updatedAt: string;
        launchedByMaster?: true;
      },
    ) => ({
      ...base,
      ...overrides,
      id: ThreadId.make(id),
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: ThreadId.make(id),
      },
    });

    const masterCanonical = makeThread(masterId, {
      projectId: masterProjectId,
      createdAt: "2026-11-25T01:00:00.000Z",
      updatedAt: "2026-11-25T02:00:00.000Z",
    });
    const idleDerived = makeThread("derived-idle", {
      projectId: appProjectId,
      launchedByMaster: true,
      createdAt: "2026-11-25T02:00:00.000Z",
      updatedAt: "2026-11-25T05:00:00.000Z",
    });
    const workingDerived = makeThread("derived-working", {
      projectId: appProjectId,
      launchedByMaster: true,
      createdAt: "2026-11-25T02:00:00.000Z",
      updatedAt: "2026-11-25T03:00:00.000Z",
      runtime: { status: "running" },
    });
    const waitingDerived = makeThread("derived-waiting", {
      projectId: appProjectId,
      launchedByMaster: true,
      createdAt: "2026-11-25T02:00:00.000Z",
      updatedAt: "2026-11-25T04:00:00.000Z",
      hasPendingUserInput: true,
    });
    const settledDerived = makeThread("derived-settled", {
      projectId: appProjectId,
      launchedByMaster: true,
      createdAt: "2026-11-25T02:00:00.000Z",
      updatedAt: "2026-11-25T06:00:00.000Z",
      settledAt: "2026-11-25T06:00:00.000Z",
    });
    const unrelated = makeThread("regular-thread", {
      projectId: appProjectId,
      createdAt: "2026-11-25T02:00:00.000Z",
      updatedAt: "2026-11-25T07:00:00.000Z",
    });

    const result = selectMasterDerivedThreads(
      [
        masterCanonical,
        idleDerived,
        settledDerived,
        unrelated,
        waitingDerived,
        workingDerived,
      ] as never,
      {
        masterProjectKeys: new Set([`${environmentId}:${masterProjectId}`]),
        masterThreadKey: `${environmentId}:${masterId}`,
      },
    );

    expect(result.map((thread) => thread.id)).toEqual([
      workingDerived.id,
      waitingDerived.id,
      idleDerived.id,
    ]);
  });
});
