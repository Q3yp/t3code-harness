import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, type Project, ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AgentWorkspaceProjectSync from "./AgentWorkspaceProjectSync.ts";
import * as AgentWorkspaceService from "./AgentWorkspaceService.ts";

function makeHarness(statePrefix: string) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const rowsRef = yield* Ref.make<ReadonlyArray<ProjectStore.ProjectRow>>([]);

      const toProject = (row: ProjectStore.ProjectRow): Project => ({
        id: row.projectId,
        title: row.title,
        workspaceRoot: row.workspaceRoot,
        repositoryIdentity: null,
        faviconPath: null,
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        autoPull: false,
        projectIcon: null,
        scripts: [],
        trackedFolders: [],
        pinnedAt: null,
        archivedAt: null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deletedAt: row.deletedAt,
      });

      const storeLayer = Layer.succeed(ProjectStore.ProjectStoreV2, {
        apply: () => Effect.void,
        get: (projectId, options) =>
          Ref.get(rowsRef).pipe(
            Effect.map((rows) =>
              Option.fromUndefinedOr(
                rows.find(
                  (row) =>
                    row.projectId === projectId &&
                    (options?.includeDeleted === true || row.deletedAt === null),
                ),
              ),
            ),
          ),
        list: (options) =>
          Ref.get(rowsRef).pipe(
            Effect.map((rows) =>
              rows.filter((row) => options?.includeDeleted === true || row.deletedAt === null),
            ),
          ),
        findActiveByWorkspaceRoot: (workspaceRoot) =>
          Ref.get(rowsRef).pipe(
            Effect.map((rows) =>
              Option.fromUndefinedOr(
                rows.find((row) => row.deletedAt === null && row.workspaceRoot === workspaceRoot),
              ),
            ),
          ),
        getShell: () => Effect.succeedNone,
        listShells: () => Effect.succeed([]),
      });

      const projectServiceLayer = Layer.succeed(ProjectService.ProjectService, {
        create: () => Effect.die("unused"),
        bootstrap: (input) =>
          Effect.gen(function* () {
            const normalized = path.resolve(input.workspaceRoot);
            const rows = yield* Ref.get(rowsRef);
            const existing = rows.find(
              (row) => row.deletedAt === null && row.workspaceRoot === normalized,
            );
            if (existing !== undefined) {
              return { project: toProject(existing), created: false };
            }
            const now = DateTime.formatIso(yield* DateTime.now);
            const nextRow: ProjectStore.ProjectRow = {
              projectId: input.projectId,
              title: input.title,
              hasCustomTitle: false,
              workspaceRoot: normalized,
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              trackedFolders: [],
              pinnedAt: null,
              archivedAt: null,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            };
            yield* Ref.update(rowsRef, (current) => [...current, nextRow]);
            return { project: toProject(nextRow), created: true };
          }),
        update: () => Effect.die("unused"),
        delete: (input) =>
          Effect.gen(function* () {
            const now = DateTime.formatIso(yield* DateTime.now);
            let removed: ProjectStore.ProjectRow | undefined;
            yield* Ref.update(rowsRef, (current) =>
              current.map((row) => {
                if (row.projectId !== input.projectId) return row;
                removed = { ...row, deletedAt: now, updatedAt: now };
                return removed;
              }),
            );
            if (removed === undefined) {
              return yield* new ProjectService.ProjectNotFoundError({ projectId: input.projectId });
            }
            return toProject(removed);
          }),
        getById: () => Effect.succeedNone,
        getByWorkspaceRoot: () => Effect.succeedNone,
        workspaceScanDirectory: (cwd) => Effect.succeed(cwd),
        snapshot: Effect.die("unused"),
        listPage: () => Effect.succeed({ projects: [], nextCursor: null }),
        getShell: () => Effect.succeedNone,
        listShells: () => Effect.succeed([]),
      });

      const base = Layer.mergeAll(
        AgentWorkspaceService.layer,
        storeLayer,
        projectServiceLayer,
      ).pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: statePrefix })));

      return AgentWorkspaceProjectSync.layer.pipe(Layer.provideMerge(base));
    }),
  ).pipe(Layer.provideMerge(NodeCrypto.layer), Layer.provideMerge(NodeServices.layer));
}

it.layer(makeHarness("t3-ws-project-sync-"))("AgentWorkspaceProjectSync", (it) => {
  it.effect(
    "auto-registers direct and wrapper subfolders, skips hidden/ignored folders, and does not resurrect deleted projects",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaces = yield* AgentWorkspaceService.AgentWorkspaceService;
        const projects = yield* ProjectService.ProjectService;
        const store = yield* ProjectStore.ProjectStoreV2;
        const sync = yield* AgentWorkspaceProjectSync.AgentWorkspaceProjectSync;

        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-sync-" });
        const codingWs = path.join(root, "coding");
        const researchWs = path.join(root, "research");

        yield* fs.makeDirectory(path.join(codingWs, "app-a"), { recursive: true });
        yield* fs.makeDirectory(path.join(codingWs, "app-b"), { recursive: true });
        yield* fs.makeDirectory(path.join(codingWs, ".agents"), { recursive: true });
        yield* fs.makeDirectory(path.join(codingWs, "node_modules"), { recursive: true });
        yield* fs.writeFileString(
          path.join(codingWs, "AGENTS.md"),
          "---\nname: coding\ndescription: Coding workspace.\n---\n# Coding\n",
        );

        yield* fs.makeDirectory(path.join(researchWs, "pi-flow"), { recursive: true });
        yield* fs.makeDirectory(path.join(researchWs, "projects", "exp-1"), { recursive: true });
        yield* fs.makeDirectory(path.join(researchWs, "projects", "exp-2"), { recursive: true });
        yield* fs.writeFileString(
          path.join(researchWs, "AGENTS.md"),
          "---\nname: research\ndescription: Research workspace.\n---\n# Research\n",
        );

        yield* workspaces.register(codingWs);
        yield* workspaces.register(researchWs);

        const created = yield* sync.syncAll({ force: true });
        const titles = created.map((project) => project.title).toSorted();
        assert.deepEqual(titles, ["app-a", "app-b", "exp-1", "exp-2", "pi-flow"]);

        // Repeat sync is idempotent.
        const secondPass = yield* sync.syncAll({ force: true });
        assert.deepEqual(secondPass, []);

        // Deleting a project prevents future syncs from resurrecting it.
        const appA = created.find((project) => project.title === "app-a");
        assert.isDefined(appA);
        yield* projects.delete({
          commandId: CommandId.make("delete-app-a"),
          projectId: ProjectId.make(appA!.id),
        });

        // Newly added folders are still picked up while the deleted one stays deleted.
        yield* fs.makeDirectory(path.join(codingWs, "app-c"), { recursive: true });
        const thirdPass = yield* sync.syncAll({ force: true });
        assert.deepEqual(
          thirdPass.map((project) => project.title),
          ["app-c"],
        );

        const activeRows = yield* store.list();
        assert.deepEqual(activeRows.map((row) => row.title).toSorted(), [
          "app-b",
          "app-c",
          "exp-1",
          "exp-2",
          "pi-flow",
        ]);

        yield* workspaces.unregister(codingWs);
        yield* workspaces.unregister(researchWs);
      }),
  );
});
