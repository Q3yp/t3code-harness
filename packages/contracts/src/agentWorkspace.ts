import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { WorktreeMcpContinuationStatus } from "./worktreeMcp.ts";

/** Lowercase words separated by hyphens, per the Agent Workspaces specification. */
export const AGENT_WORKSPACE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const AgentWorkspaceName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(AGENT_WORKSPACE_NAME_PATTERN),
);
export type AgentWorkspaceName = typeof AgentWorkspaceName.Type;

export const AgentWorkspaceSummary = Schema.Struct({
  name: AgentWorkspaceName,
  description: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
});
export type AgentWorkspaceSummary = typeof AgentWorkspaceSummary.Type;

export const AgentWorkspaceCatalog = Schema.Struct({
  workspaces: Schema.Array(AgentWorkspaceSummary),
  errors: Schema.Array(Schema.String),
});
export type AgentWorkspaceCatalog = typeof AgentWorkspaceCatalog.Type;

export const ThreadActiveWorkspace = Schema.Struct({
  name: AgentWorkspaceName,
  path: TrimmedNonEmptyString,
});
export type ThreadActiveWorkspace = typeof ThreadActiveWorkspace.Type;

export class AgentWorkspaceError extends Schema.TaggedError<AgentWorkspaceError>()(
  "AgentWorkspaceError",
  {
    code: Schema.Literals([
      "invalid_path",
      "invalid_metadata",
      "duplicate_name",
      "not_found",
      "catalog_error",
      "operation_failed",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const AgentWorkspaceListInput = Schema.Struct({});
export type AgentWorkspaceListInput = typeof AgentWorkspaceListInput.Type;

export const AgentWorkspaceListResult = AgentWorkspaceCatalog;
export type AgentWorkspaceListResult = typeof AgentWorkspaceListResult.Type;

export const AgentWorkspaceRegisterInput = Schema.Struct({
  path: TrimmedNonEmptyString,
});
export type AgentWorkspaceRegisterInput = typeof AgentWorkspaceRegisterInput.Type;

export const AgentWorkspaceRegisterResult = Schema.Struct({
  workspace: AgentWorkspaceSummary,
  catalog: AgentWorkspaceCatalog,
});
export type AgentWorkspaceRegisterResult = typeof AgentWorkspaceRegisterResult.Type;

export const AgentWorkspaceUnregisterInput = Schema.Struct({
  path: TrimmedNonEmptyString,
});
export type AgentWorkspaceUnregisterInput = typeof AgentWorkspaceUnregisterInput.Type;

export const AgentWorkspaceUnregisterResult = Schema.Struct({
  removedPath: TrimmedNonEmptyString,
  catalog: AgentWorkspaceCatalog,
});
export type AgentWorkspaceUnregisterResult = typeof AgentWorkspaceUnregisterResult.Type;

export const AgentWorkspaceMcpListResult = Schema.Struct({
  workspaces: Schema.Array(AgentWorkspaceSummary),
  errors: Schema.Array(Schema.String),
  activeWorkspace: Schema.NullOr(ThreadActiveWorkspace),
});
export type AgentWorkspaceMcpListResult = typeof AgentWorkspaceMcpListResult.Type;

export const AgentWorkspaceMcpActivateInput = Schema.Struct({
  name: TrimmedNonEmptyString.annotate({
    description: "Workspace name from the catalog.",
  }),
  continuationPrompt: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
      description:
        "Work to continue in the workspace next turn. Defaults to continuing the user's request.",
    }),
  ),
});
export type AgentWorkspaceMcpActivateInput = typeof AgentWorkspaceMcpActivateInput.Type;

export const AgentWorkspaceMcpActivateResult = Schema.Struct({
  name: AgentWorkspaceName,
  description: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  source: TrimmedNonEmptyString,
  instructions: Schema.optional(Schema.String),
  continuation: WorktreeMcpContinuationStatus,
  note: Schema.String,
});
export type AgentWorkspaceMcpActivateResult = typeof AgentWorkspaceMcpActivateResult.Type;

export const AgentWorkspaceMcpClearInput = Schema.Struct({
  continuationPrompt: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
      description: "Optional work to continue after restoring the thread's original working root.",
    }),
  ),
});
export type AgentWorkspaceMcpClearInput = typeof AgentWorkspaceMcpClearInput.Type;

export const AgentWorkspaceMcpClearResult = Schema.Struct({
  clearedWorkspace: Schema.NullOr(ThreadActiveWorkspace),
  restoredCwd: TrimmedNonEmptyString,
  continuation: WorktreeMcpContinuationStatus,
  note: Schema.String,
});
export type AgentWorkspaceMcpClearResult = typeof AgentWorkspaceMcpClearResult.Type;

export const AgentWorkspaceMcpRegisterInput = Schema.Struct({
  path: TrimmedNonEmptyString.annotate({
    description: "User-authorized absolute folder path containing AGENTS.md with frontmatter.",
  }),
});
export type AgentWorkspaceMcpRegisterInput = typeof AgentWorkspaceMcpRegisterInput.Type;

export const AgentWorkspaceMcpUnregisterInput = Schema.Struct({
  path: TrimmedNonEmptyString.annotate({
    description: "Absolute folder path of the registered workspace to remove from the catalog.",
  }),
});
export type AgentWorkspaceMcpUnregisterInput = typeof AgentWorkspaceMcpUnregisterInput.Type;

export class AgentWorkspaceMcpFailure extends Schema.TaggedError<AgentWorkspaceMcpFailure>()(
  "AgentWorkspaceMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "thread_credential_required",
      "thread_not_found",
      "project_not_found",
      "invalid_request",
      "catalog_error",
      "not_found",
      "operation_failed",
    ]),
    message: Schema.String,
  },
) {}
