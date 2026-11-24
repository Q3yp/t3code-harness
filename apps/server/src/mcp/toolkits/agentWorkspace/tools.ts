import {
  AgentWorkspaceCreateResult,
  AgentWorkspaceMcpActivateInput,
  AgentWorkspaceMcpActivateResult,
  AgentWorkspaceMcpClearInput,
  AgentWorkspaceMcpClearResult,
  AgentWorkspaceMcpCreateInput,
  AgentWorkspaceMcpFailure,
  AgentWorkspaceMcpListResult,
  AgentWorkspaceMcpRegisterInput,
  AgentWorkspaceMcpUnregisterInput,
  AgentWorkspaceRegisterResult,
  AgentWorkspaceUnregisterResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as AgentWorkspaceMcpService from "../../AgentWorkspaceMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  AgentWorkspaceMcpService.AgentWorkspaceMcpService,
  ThreadManagementService.ThreadManagementService,
];

const AgentWorkspaceToolFailure = Schema.Union([AgentWorkspaceMcpFailure, OrchestratorMcpFailure]);

const WorkspaceListTool = Tool.make("workspace_list", {
  description:
    "List registered Agent Workspaces (live names, descriptions, paths), registration errors, and this thread's active workspace.",
  success: AgentWorkspaceMcpListResult,
  failure: AgentWorkspaceToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List registered workspaces")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const WorkspaceActivateTool = Tool.make("workspace_activate", {
  description:
    "Activate a registered workspace on THIS thread: reads its live AGENTS.md, switches this thread's working root to the workspace path, and automatically continues work in the new root on the next turn. Call last in your turn. Fails if the catalog has errors or the name is unknown.",
  parameters: AgentWorkspaceMcpActivateInput,
  success: AgentWorkspaceMcpActivateResult,
  failure: AgentWorkspaceToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Activate workspace for this thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const WorkspaceClearTool = Tool.make("workspace_clear", {
  description:
    "Clear this thread's active workspace and restore its original project or worktree working root.",
  parameters: AgentWorkspaceMcpClearInput,
  success: AgentWorkspaceMcpClearResult,
  failure: AgentWorkspaceToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Clear active workspace")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const WorkspaceRegisterTool = Tool.make("workspace_register", {
  description:
    "Register a user-authorized absolute workspace folder containing AGENTS.md with valid name and description frontmatter.",
  parameters: AgentWorkspaceMcpRegisterInput,
  success: AgentWorkspaceRegisterResult,
  failure: AgentWorkspaceToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Register workspace folder")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CreateWorkspaceTool = Tool.make("create_workspace", {
  description:
    "Create and register a user-authorized Agent Workspace folder following the Agent Workspaces standard: a directory with a top-level AGENTS.md whose YAML frontmatter defines only `name` (unique lowercase letters/digits separated by hyphens) and `description` (one nonempty line for catalog discovery), followed by shared Markdown `instructions` linking to focused guideline files while keeping individual work in subfolders (with optional nested AGENTS.md). Separate from skills. Refuses to overwrite an existing AGENTS.md.",
  parameters: AgentWorkspaceMcpCreateInput,
  success: AgentWorkspaceCreateResult,
  failure: AgentWorkspaceToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create and register workspace")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const WorkspaceUnregisterTool = Tool.make("workspace_unregister", {
  description: "Remove a workspace folder from the catalog without deleting any workspace files.",
  parameters: AgentWorkspaceMcpUnregisterInput,
  success: AgentWorkspaceUnregisterResult,
  failure: AgentWorkspaceToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Unregister workspace folder")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const AgentWorkspaceToolkit = Toolkit.make(
  WorkspaceListTool,
  WorkspaceActivateTool,
  WorkspaceClearTool,
  WorkspaceRegisterTool,
  CreateWorkspaceTool,
  WorkspaceUnregisterTool,
);
