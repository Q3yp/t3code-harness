import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  type AgentWorkspaceCreateResult,
  type AgentWorkspaceError,
  type AgentWorkspaceMcpActivateInput,
  type AgentWorkspaceMcpActivateResult,
  type AgentWorkspaceMcpClearInput,
  type AgentWorkspaceMcpClearResult,
  type AgentWorkspaceMcpCreateInput,
  AgentWorkspaceMcpFailure,
  type AgentWorkspaceMcpListResult,
  type AgentWorkspaceRegisterResult,
  type AgentWorkspaceUnregisterResult,
  CommandId,
  MessageId,
  type ProjectId,
  type WorktreeMcpContinuationStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AgentWorkspaceService from "../workspace/AgentWorkspaceService.ts";
import * as AgentWorkspaceProjectSync from "../workspace/AgentWorkspaceProjectSync.ts";
import type { McpInvocationScope, McpThreadInvocationScope } from "./McpInvocationContext.ts";

export class AgentWorkspaceMcpService extends Context.Service<
  AgentWorkspaceMcpService,
  {
    readonly list: (
      scope: McpInvocationScope,
    ) => Effect.Effect<AgentWorkspaceMcpListResult, AgentWorkspaceMcpFailure>;
    readonly activate: (
      scope: McpInvocationScope,
      input: AgentWorkspaceMcpActivateInput,
    ) => Effect.Effect<AgentWorkspaceMcpActivateResult, AgentWorkspaceMcpFailure>;
    readonly clear: (
      scope: McpInvocationScope,
      input: AgentWorkspaceMcpClearInput,
    ) => Effect.Effect<AgentWorkspaceMcpClearResult, AgentWorkspaceMcpFailure>;
    readonly register: (
      scope: McpInvocationScope,
      path: string,
    ) => Effect.Effect<AgentWorkspaceRegisterResult, AgentWorkspaceMcpFailure>;
    readonly create: (
      scope: McpInvocationScope,
      input: AgentWorkspaceMcpCreateInput,
    ) => Effect.Effect<AgentWorkspaceCreateResult, AgentWorkspaceMcpFailure>;
    readonly unregister: (
      scope: McpInvocationScope,
      path: string,
    ) => Effect.Effect<AgentWorkspaceUnregisterResult, AgentWorkspaceMcpFailure>;
  }
>()("t3/mcp/AgentWorkspaceMcpService") {}

function failure(
  code: AgentWorkspaceMcpFailure["code"],
  message: string,
): AgentWorkspaceMcpFailure {
  return new AgentWorkspaceMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function mapWorkspaceError(error: AgentWorkspaceError): AgentWorkspaceMcpFailure {
  switch (error.code) {
    case "not_found":
      return failure("not_found", error.message);
    case "catalog_error":
      return failure("catalog_error", error.message);
    case "invalid_path":
    case "invalid_metadata":
    case "duplicate_name":
      return failure("invalid_request", error.message);
    case "operation_failed":
      return failure("operation_failed", error.message);
  }
}

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const workspaces = yield* AgentWorkspaceService.AgentWorkspaceService;
  const projectSync = Option.getOrUndefined(
    yield* Effect.serviceOption(AgentWorkspaceProjectSync.AgentWorkspaceProjectSync),
  );
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const platform = yield* HostProcess.Platform;
  // Serialize activations per thread so concurrent tool calls do not queue duplicate continuations.
  const activationsInFlight = new Set<string>();

  const requireThreadScope = (scope: McpInvocationScope) =>
    scope.thread === undefined
      ? Effect.fail(
          failure(
            "thread_credential_required",
            "Activating or clearing a workspace acts on the calling T3 thread, so it needs an agent running inside T3 Code.",
          ),
        )
      : Effect.succeed(scope as McpThreadInvocationScope);

  const loadThread = (scope: McpThreadInvocationScope) =>
    threadManagement.getThreadRecords(scope.thread.threadId, []).pipe(
      Effect.mapError((error) =>
        error._tag === "OrchestratorProjectionError"
          ? failure("thread_not_found", `Thread '${scope.thread.threadId}' was not found.`)
          : failure(
              "operation_failed",
              `Unable to read thread ${scope.thread.threadId}: ${errorMessage(error)}`,
            ),
      ),
      Effect.filterOrFail(
        (projection) => projection.thread.deletedAt === null,
        () => failure("thread_not_found", `Thread '${scope.thread.threadId}' was not found.`),
      ),
    );

  const loadProject = (scope: McpThreadInvocationScope, projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError((error) =>
        failure("operation_failed", `Unable to read project ${projectId}: ${errorMessage(error)}`),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              failure(
                "project_not_found",
                `Project '${projectId}' was not found for thread '${scope.thread.threadId}'.`,
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const commandIds = (scope: McpThreadInvocationScope, operation: string) =>
    random.uuidV4().pipe(
      Effect.map((uuid) => {
        const part = (kind: string, label: string) =>
          [kind, "mcp", encodeURIComponent(scope.thread.providerSessionId), label, uuid].join(":");
        return {
          commandId: CommandId.make(part("command", operation)),
          continuationMessageId: MessageId.make(part("message", `${operation}-continuation`)),
        };
      }),
      Effect.orDie,
    );

  const list: AgentWorkspaceMcpService["Service"]["list"] = Effect.fn(
    "AgentWorkspaceMcpService.list",
  )(function* (scope) {
    const catalog = yield* workspaces.list().pipe(Effect.mapError(mapWorkspaceError));
    const activeWorkspace =
      scope.thread === undefined
        ? null
        : yield* threadManagement.getThreadRecords(scope.thread.threadId, []).pipe(
            Effect.map((projection) => projection.thread.activeWorkspace ?? null),
            Effect.orElseSucceed(() => null),
          );
    return {
      workspaces: catalog.workspaces,
      errors: catalog.errors,
      activeWorkspace,
    };
  });

  const performActivate = Effect.fn("AgentWorkspaceMcpService.performActivate")(function* (
    scope: McpThreadInvocationScope,
    input: AgentWorkspaceMcpActivateInput,
  ) {
    const projection = yield* loadThread(scope);
    if (projection.thread.archivedAt !== null) {
      return yield* failure(
        "invalid_request",
        `Thread '${scope.thread.threadId}' is archived and cannot activate a workspace.`,
      );
    }

    const live = yield* workspaces.readLive(input.name).pipe(Effect.mapError(mapWorkspaceError));
    const currentPath = projection.thread.activeWorkspace?.path ?? null;
    const sameWorkspace =
      currentPath !== null &&
      (platform === "win32"
        ? currentPath.toLowerCase() === live.workspace.path.toLowerCase()
        : currentPath === live.workspace.path);

    if (sameWorkspace) {
      return {
        name: live.workspace.name,
        description: live.workspace.description,
        path: live.workspace.path,
        source: live.source,
        instructions: live.instructions,
        continuation: { status: "skipped" } as const,
        note: `Workspace '${live.workspace.name}' is already active as this thread's working root (${live.workspace.path}). Live instructions were reloaded.`,
      };
    }

    const ids = yield* commandIds(scope, "workspace-activate");
    const continuationText = [
      `Workspace "${live.workspace.name}" is now active. Your working root is ${live.workspace.path}.`,
      `Source: ${live.source}`,
      "",
      live.instructions,
      "",
      input.continuationPrompt ??
        "Continue the user's request in this workspace using the live instructions above.",
    ].join("\n");

    const bound = yield* threadManagement
      .dispatch({
        type: "thread.metadata.update",
        commandId: ids.commandId,
        threadId: scope.thread.threadId,
        activeWorkspace: {
          name: live.workspace.name,
          path: live.workspace.path,
        },
        continuation: {
          messageId: ids.continuationMessageId,
          text: continuationText,
        },
      })
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.fail(
                failure(
                  "operation_failed",
                  `Unable to activate workspace '${live.workspace.name}': ${errorMessage(Cause.squash(cause))}`,
                ),
              ),
        ),
      );

    const continuation: WorktreeMcpContinuationStatus = {
      status: "scheduled",
      delivery: bound.storedEvents.some(
        ({ event }) => event.type === "run.created" && event.payload.status !== "queued",
      )
        ? "started"
        : "queued",
    };

    return {
      name: live.workspace.name,
      description: live.workspace.description,
      path: live.workspace.path,
      source: live.source,
      continuation,
      note: "Workspace activation accepted. Changing the working root detaches this provider session, so the current turn ends shortly after this call; the continuation turn automatically starts in the new workspace root with its live instructions and preserved conversation.",
    };
  });

  const activate: AgentWorkspaceMcpService["Service"]["activate"] = Effect.fn(
    "AgentWorkspaceMcpService.activate",
  )(function* (callerScope, input) {
    const scope = yield* requireThreadScope(callerScope);
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        if (activationsInFlight.has(scope.thread.threadId)) {
          return Effect.fail(
            failure(
              "invalid_request",
              `A workspace activation is already in progress for thread '${scope.thread.threadId}'.`,
            ),
          );
        }
        activationsInFlight.add(scope.thread.threadId);
        return restore(performActivate(scope, input)).pipe(
          Effect.ensuring(Effect.sync(() => activationsInFlight.delete(scope.thread.threadId))),
        );
      }),
    );
  });

  const clear: AgentWorkspaceMcpService["Service"]["clear"] = Effect.fn(
    "AgentWorkspaceMcpService.clear",
  )(function* (callerScope, input) {
    const scope = yield* requireThreadScope(callerScope);
    const projection = yield* loadThread(scope);
    if (projection.thread.archivedAt !== null) {
      return yield* failure(
        "invalid_request",
        `Thread '${scope.thread.threadId}' is archived and cannot clear its workspace.`,
      );
    }
    const project = yield* loadProject(scope, projection.thread.projectId);
    const restoredCwd = projection.thread.worktreePath ?? project.workspaceRoot;
    const previous = projection.thread.activeWorkspace ?? null;
    if (previous === null) {
      return {
        clearedWorkspace: null,
        restoredCwd,
        continuation: { status: "skipped" } as const,
        note: `No workspace is active on this thread. Current working root remains ${restoredCwd}.`,
      };
    }

    const ids = yield* commandIds(scope, "workspace-clear");
    const bound = yield* threadManagement
      .dispatch({
        type: "thread.metadata.update",
        commandId: ids.commandId,
        threadId: scope.thread.threadId,
        activeWorkspace: null,
        ...(input.continuationPrompt === undefined
          ? {}
          : {
              continuation: {
                messageId: ids.continuationMessageId,
                text: input.continuationPrompt,
              },
            }),
      })
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.fail(
                failure(
                  "operation_failed",
                  `Unable to clear active workspace: ${errorMessage(Cause.squash(cause))}`,
                ),
              ),
        ),
      );

    const continuation: WorktreeMcpContinuationStatus =
      input.continuationPrompt === undefined
        ? { status: "skipped" }
        : {
            status: "scheduled",
            delivery: bound.storedEvents.some(
              ({ event }) => event.type === "run.created" && event.payload.status !== "queued",
            )
              ? "started"
              : "queued",
          };

    return {
      clearedWorkspace: previous,
      restoredCwd,
      continuation,
      note:
        continuation.status === "scheduled"
          ? `Cleared workspace '${previous.name}'. The session detaches and continues in ${restoredCwd}.`
          : `Cleared workspace '${previous.name}'. The session detaches and subsequent turns run in ${restoredCwd}.`,
    };
  });

  const register: AgentWorkspaceMcpService["Service"]["register"] = Effect.fn(
    "AgentWorkspaceMcpService.register",
  )(function* (_scope, workspacePath) {
    return yield* workspaces.register(workspacePath).pipe(
      Effect.tap((result) =>
        projectSync === undefined ? Effect.void : projectSync.syncWorkspace(result.workspace.path),
      ),
      Effect.mapError(mapWorkspaceError),
    );
  });

  const create: AgentWorkspaceMcpService["Service"]["create"] = Effect.fn(
    "AgentWorkspaceMcpService.create",
  )(function* (_scope, input) {
    return yield* workspaces.create(input).pipe(
      Effect.tap((result) =>
        projectSync === undefined ? Effect.void : projectSync.syncWorkspace(result.workspace.path),
      ),
      Effect.mapError(mapWorkspaceError),
    );
  });

  const unregister: AgentWorkspaceMcpService["Service"]["unregister"] = Effect.fn(
    "AgentWorkspaceMcpService.unregister",
  )(function* (_scope, workspacePath) {
    return yield* workspaces.unregister(workspacePath).pipe(Effect.mapError(mapWorkspaceError));
  });

  return AgentWorkspaceMcpService.of({
    list,
    activate,
    clear,
    register,
    create,
    unregister,
  });
});

export const layer: Layer.Layer<
  AgentWorkspaceMcpService,
  never,
  | SecureRandom.SecureRandom
  | AgentWorkspaceService.AgentWorkspaceService
  | ThreadManagementService.ThreadManagementService
  | ProjectService.ProjectService
> = Layer.effect(AgentWorkspaceMcpService, make);
