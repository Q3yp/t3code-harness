import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type ThreadActiveWorkspace,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AgentWorkspaceService from "../workspace/AgentWorkspaceService.ts";
import * as AgentWorkspaceMcpService from "./AgentWorkspaceMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const TEST_ENV_ID = EnvironmentId.make("env-ws-test");
const TEST_PROJECT_ID = ProjectId.make("project-ws-test");
const TEST_THREAD_ID = ThreadId.make("thread-ws-test");

function makeScope(): McpInvocationScope {
  return {
    environmentId: TEST_ENV_ID,
    capabilities: new Set(["orchestration", "worktree"]),
    issuedAt: 0,
    requestNamespace: "test",
    thread: {
      threadId: TEST_THREAD_ID,
      providerSessionId: "session-ws-1",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
  };
}

it.effect(
  "activates a workspace with auto-continuation, preserves worktreePath, and clears back",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-mcp-" });
      const projectRoot = path.join(root, "repo");
      const worktreeRoot = path.join(root, "repo-wt");
      const workspaceDir = path.join(root, "video-workspace");

      yield* fs.makeDirectory(projectRoot, { recursive: true });
      yield* fs.makeDirectory(worktreeRoot, { recursive: true });
      yield* fs.makeDirectory(workspaceDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(workspaceDir, "AGENTS.md"),
        [
          "---",
          "name: video-production",
          "description: Video direction, assets, and editing.",
          "---",
          "",
          "# Video production",
          "Keep each film in its own folder.",
        ].join("\n"),
      );

      const dispatched: Array<OrchestrationV2ServerCommand> = [];
      let currentActiveWorkspace: ThreadActiveWorkspace | null = null;
      const now = DateTime.makeUnsafe("2026-11-23T00:00:00.000Z");

      const buildThread = () =>
        ({
          id: TEST_THREAD_ID,
          projectId: TEST_PROJECT_ID,
          title: "Test thread",
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feat/demo",
          worktreePath: worktreeRoot,
          activeWorkspace: currentActiveWorkspace,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: TEST_THREAD_ID,
          },
          forkedFrom: null,
          createdBy: "user",
          creationSource: "web",
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        }) as unknown as OrchestrationV2ThreadProjection["thread"];

      const mockThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: () => Effect.succeed({ thread: buildThread() } as never),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            if (
              command.type === "thread.metadata.update" &&
              command.activeWorkspace !== undefined
            ) {
              currentActiveWorkspace = command.activeWorkspace;
            }
            return {
              sequence: dispatched.length,
              storedEvents: [
                {
                  sequence: dispatched.length,
                  event: {
                    id: EventId.make(`event-${dispatched.length}`),
                    type: "run.created",
                    threadId: TEST_THREAD_ID,
                    runId: RunId.make(`run-${dispatched.length}`),
                    providerInstanceId: ProviderInstanceId.make("codex"),
                    occurredAt: now,
                    payload: { status: "running" },
                  },
                },
              ],
            } as never;
          }),
      });

      const mockProjects = Layer.mock(ProjectService.ProjectService)({
        getById: () =>
          Effect.succeedSome({
            id: TEST_PROJECT_ID,
            title: "repo",
            workspaceRoot: projectRoot,
            scripts: [],
          } as never),
      });

      const layer = AgentWorkspaceMcpService.layer.pipe(
        Layer.provideMerge(AgentWorkspaceService.layer),
        Layer.provideMerge(mockThreads),
        Layer.provideMerge(mockProjects),
        Layer.provideMerge(ServerConfig.layerTest(projectRoot, { prefix: "t3-ws-mcp-state-" })),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(NodeCrypto.layer),
      );

      yield* Effect.gen(function* () {
        const mcp = yield* AgentWorkspaceMcpService.AgentWorkspaceMcpService;
        const scope = makeScope();

        const registered = yield* mcp.register(scope, workspaceDir);
        assert.equal(registered.workspace.name, "video-production");

        const listed = yield* mcp.list(scope);
        assert.equal(listed.workspaces.length, 1);
        assert.isNull(listed.activeWorkspace);

        const activated = yield* mcp.activate(scope, {
          name: "video-production",
          continuationPrompt: "Plan the film brief.",
        });
        assert.equal(activated.name, "video-production");
        assert.isUndefined(activated.instructions);
        assert.equal(activated.continuation.status, "scheduled");
        assert.equal(dispatched.length, 1);
        const activateCmd = dispatched[0];
        assert.isDefined(activateCmd);
        if (activateCmd?.type === "thread.metadata.update") {
          assert.equal(activateCmd.activeWorkspace?.name, "video-production");
          assert.isUndefined(activateCmd.worktreePath);
          assert.include(activateCmd.continuation?.text ?? "", "Plan the film brief.");
          assert.include(activateCmd.continuation?.text ?? "", "Keep each film in its own folder.");
        }

        const reloaded = yield* mcp.activate(scope, { name: "video-production" });
        assert.equal(reloaded.continuation.status, "skipped");
        assert.include(reloaded.instructions ?? "", "Keep each film in its own folder.");

        const listedAfter = yield* mcp.list(scope);
        assert.equal(listedAfter.activeWorkspace?.name, "video-production");

        const cleared = yield* mcp.clear(scope, {});
        assert.equal(cleared.clearedWorkspace?.name, "video-production");
        assert.equal(cleared.restoredCwd, worktreeRoot);
        assert.isNull((yield* mcp.list(scope)).activeWorkspace);

        const createdPath = path.join(root, "writing-workspace");
        const created = yield* mcp.create(scope, {
          path: createdPath,
          name: "writing",
          description: "Fiction and novel writing.",
          instructions: "# Writing\n\nFollow prose-craft.md.",
        });
        assert.equal(created.workspace.name, "writing");
        assert.equal(created.source, path.join(created.workspace.path, "AGENTS.md"));
        assert.equal(created.catalog.workspaces.length, 2);

        const activatedCreated = yield* mcp.activate(scope, {
          name: "writing",
          continuationPrompt: "Draft chapter 1.",
        });
        assert.equal(activatedCreated.name, "writing");
        assert.equal(activatedCreated.continuation.status, "scheduled");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);
