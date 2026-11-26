import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import {
  isListedThreadLineage,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ScopedProjectRef,
  type ThreadActiveWorkspace,
} from "@t3tools/contracts";
import type { ComposerThreadDraftState, DraftThreadEnvMode } from "../composerDraftStore";

function threadCreatedMs(thread: Pick<EnvironmentThreadShell, "createdAt" | "updatedAt">): number {
  const created = Date.parse(thread.createdAt);
  if (Number.isFinite(created)) return created;
  const updated = Date.parse(thread.updatedAt);
  return Number.isFinite(updated) ? updated : Number.POSITIVE_INFINITY;
}

/**
 * Picks the single canonical Master thread for a Master project: prefers user-created
 * threads over MCP-spawned threads and selects the oldest created thread so an accidental
 * newer thread in the Master project can never hijack the Master slot.
 */
export function selectCanonicalMasterThread<
  T extends Pick<
    EnvironmentThreadShell,
    | "environmentId"
    | "id"
    | "projectId"
    | "createdAt"
    | "updatedAt"
    | "deletedAt"
    | "archivedAt"
    | "lineage"
  >,
>(
  threads: ReadonlyArray<T>,
  masterProject: Pick<EnvironmentProject, "environmentId" | "id"> | null,
): T | null {
  if (masterProject === null) return null;
  const candidates = threads.filter(
    (thread) =>
      thread.environmentId === masterProject.environmentId &&
      thread.projectId === masterProject.id &&
      thread.deletedAt === null &&
      thread.archivedAt === null &&
      isListedThreadLineage(thread.lineage),
  );
  if (candidates.length === 0) return null;
  return (
    candidates.toSorted((left, right) => {
      const leftMcp = left.id.startsWith("thread:mcp:") ? 1 : 0;
      const rightMcp = right.id.startsWith("thread:mcp:") ? 1 : 0;
      if (leftMcp !== rightMcp) return leftMcp - rightMcp;
      const createdDiff = threadCreatedMs(left) - threadCreatedMs(right);
      if (createdDiff !== 0) return createdDiff;
      return left.id.localeCompare(right.id);
    })[0] ?? null
  );
}

function threadActivityMs(thread: Pick<EnvironmentThreadShell, "updatedAt" | "createdAt">): number {
  const updated = Date.parse(thread.updatedAt);
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(thread.createdAt);
  return Number.isFinite(created) ? created : 0;
}

/**
 * Lists active (non-settled, non-archived, non-deleted) top-level sessions launched from Master,
 * ordered with working sessions first, then sessions waiting on input/approval, then newest.
 */
export function selectMasterDerivedThreads<
  T extends Pick<
    EnvironmentThreadShell,
    | "environmentId"
    | "id"
    | "projectId"
    | "createdAt"
    | "updatedAt"
    | "deletedAt"
    | "archivedAt"
    | "lineage"
    | "settledOverride"
    | "settledAt"
    | "runtime"
    | "latestRun"
    | "interactionMode"
    | "hasActionableProposedPlan"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "launchedByMaster"
  >,
>(
  threads: ReadonlyArray<T>,
  options: {
    readonly masterProjectKeys: ReadonlySet<string>;
    readonly masterThreadKey: string | null;
  },
): ReadonlyArray<T> {
  return threads
    .filter((thread) => {
      if (
        thread.deletedAt !== null ||
        thread.archivedAt !== null ||
        !isListedThreadLineage(thread.lineage)
      ) {
        return false;
      }
      const isSettled =
        thread.settledOverride === "settled" ||
        (thread.settledOverride === null && thread.settledAt !== null);
      if (isSettled) return false;
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      if (key === options.masterThreadKey) return false;
      return (
        thread.launchedByMaster === true ||
        options.masterProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)
      );
    })
    .toSorted((left, right) => {
      const leftWorking = isThreadWorking(left) ? 1 : 0;
      const rightWorking = isThreadWorking(right) ? 1 : 0;
      if (leftWorking !== rightWorking) return rightWorking - leftWorking;
      const leftAttention = left.hasPendingApprovals || left.hasPendingUserInput ? 1 : 0;
      const rightAttention = right.hasPendingApprovals || right.hasPendingUserInput ? 1 : 0;
      if (leftAttention !== rightAttention) return rightAttention - leftAttention;
      const timeDiff = threadActivityMs(right) - threadActivityMs(left);
      if (timeDiff !== 0) return timeDiff;
      return left.id.localeCompare(right.id);
    });
}

type ComposerModelSelectionState = Pick<
  ComposerThreadDraftState,
  "activeProvider" | "modelSelectionByProvider" | "modelSelectionExplicit"
>;

interface ThreadContextLike {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  activeWorkspace?: ThreadActiveWorkspace | null | undefined;
}

interface NewThreadHandler {
  (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      activeWorkspace?: ThreadActiveWorkspace | null;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
    },
  ): Promise<unknown>;
}

export interface ChatThreadActionContext {
  readonly activeDraftThread: ThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  /** Master is a singleton assistant thread; new-thread shortcuts fall back to a normal project. */
  readonly activeProjectIsMaster?: boolean | undefined;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly handleNewThread: NewThreadHandler;
}

export function resolveNewDraftStartFromOrigin(input: {
  envMode: DraftThreadEnvMode;
  newWorktreesStartFromOrigin: boolean;
}): boolean {
  return input.envMode === "worktree" && input.newWorktreesStartFromOrigin;
}

export function resolveNewThreadModelSelectionOverride(input: {
  readonly projectDefaultSelection: ModelSelection | null;
  readonly carrySelection: ModelSelection | null;
  readonly carrySourceDraftId: string | null;
  readonly destinationDraftId: string;
}): ModelSelection | null {
  return (
    input.projectDefaultSelection ??
    (input.carrySourceDraftId === input.destinationDraftId ? null : input.carrySelection)
  );
}

export function hasExplicitComposerModelSelection(
  draft: ComposerModelSelectionState | null | undefined,
): boolean {
  const activeProvider = draft?.activeProvider;
  return (
    draft?.modelSelectionExplicit === true &&
    activeProvider !== null &&
    activeProvider !== undefined &&
    draft.modelSelectionByProvider[activeProvider] !== undefined
  );
}

export function threadHasStarted(
  thread: Pick<EnvironmentThreadShell, "latestRun" | "itemCount" | "runtime"> | null | undefined,
): boolean {
  return Boolean(thread && (thread.latestRun !== null || thread.itemCount > 0 || thread.runtime));
}

/**
 * A draft is seeded from sticky state, project defaults, prompt links, or a carried selection.
 * That seed is what an unstarted thread sends; once the thread has started, its own selection
 * wins unless the user picked a model or traits for it.
 */
export function draftModelSelectionApplies(
  draft: Pick<ComposerThreadDraftState, "modelSelectionExplicit"> | null | undefined,
  threadStarted: boolean,
): boolean {
  return !threadStarted || draft?.modelSelectionExplicit === true;
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): ScopedProjectRef | null {
  if (!context.activeProjectIsMaster) {
    if (context.activeThread) {
      return scopeProjectRef(context.activeThread.environmentId, context.activeThread.projectId);
    }
    if (context.activeDraftThread) {
      return scopeProjectRef(
        context.activeDraftThread.environmentId,
        context.activeDraftThread.projectId,
      );
    }
  }
  return context.defaultProjectRef;
}

export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  const activeWorkspace = context.activeProjectIsMaster
    ? null
    : context.activeThread
      ? (context.activeThread.activeWorkspace ?? null)
      : context.activeDraftThread
        ? (context.activeDraftThread.activeWorkspace ?? null)
        : null;
  await (activeWorkspace
    ? context.handleNewThread(projectRef, { activeWorkspace })
    : context.handleNewThread(projectRef));
  return true;
}
