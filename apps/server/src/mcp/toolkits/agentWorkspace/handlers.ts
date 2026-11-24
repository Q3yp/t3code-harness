import * as Effect from "effect/Effect";

import * as AgentWorkspaceMcpService from "../../AgentWorkspaceMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { AgentWorkspaceToolkit } from "./tools.ts";

const handlers = {
  workspace_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* AgentWorkspaceMcpService.AgentWorkspaceMcpService;
      return yield* service.list(scope);
    }),
  ),
  workspace_activate: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* AgentWorkspaceMcpService.AgentWorkspaceMcpService;
      return yield* service.activate(scope, input);
    }),
  ),
  workspace_clear: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* AgentWorkspaceMcpService.AgentWorkspaceMcpService;
      return yield* service.clear(scope, input);
    }),
  ),
  workspace_register: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* AgentWorkspaceMcpService.AgentWorkspaceMcpService;
      return yield* service.register(scope, input.path);
    }),
  ),
  create_workspace: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* AgentWorkspaceMcpService.AgentWorkspaceMcpService;
      return yield* service.create(scope, input);
    }),
  ),
  workspace_unregister: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* AgentWorkspaceMcpService.AgentWorkspaceMcpService;
      return yield* service.unregister(scope, input.path);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof AgentWorkspaceToolkit.tools>;

export const layer = McpToolAccess.toLayer(AgentWorkspaceToolkit, handlers);
