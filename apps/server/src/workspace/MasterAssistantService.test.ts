import { DEFAULT_SERVER_SETTINGS, type Project, type ProjectId } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MasterAssistantService from "./MasterAssistantService.ts";

function makeTestLayer(input: {
  readonly baseDir: string;
  readonly configuredMasterRoot?: string;
}) {
  const projectsById = new Map<ProjectId, Project>();
  const projectServiceLayer = Layer.mock(ProjectService.ProjectService)({
    bootstrap: (payload) =>
      Effect.sync(() => {
        const existing = [...projectsById.values()].find(
          (project) => project.workspaceRoot.toLowerCase() === payload.workspaceRoot.toLowerCase(),
        );
        if (existing) {
          return { project: existing, created: false };
        }
        const now = DateTime.formatIso(DateTime.makeUnsafe(0));
        const created: Project = {
          id: payload.projectId,
          title: payload.title,
          workspaceRoot: payload.workspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
        projectsById.set(created.id, created);
        return { project: created, created: true };
      }),
    update: (payload) =>
      Effect.sync(() => {
        const existing = projectsById.get(payload.projectId)!;
        const updated: Project = {
          ...existing,
          ...(payload.projectIcon === undefined ? {} : { projectIcon: payload.projectIcon }),
        };
        projectsById.set(updated.id, updated);
        return updated;
      }),
    getById: (id) => Effect.succeed(Option.fromUndefinedOr(projectsById.get(id))),
    getByWorkspaceRoot: (workspaceRoot) =>
      Effect.succeed(
        Option.fromUndefinedOr(
          [...projectsById.values()].find(
            (project) => project.workspaceRoot.toLowerCase() === workspaceRoot.toLowerCase(),
          ),
        ),
      ),
  });

  const serverSettingsLayer = Layer.mock(ServerSettings.ServerSettingsService)({
    getSettings: Effect.succeed({
      ...DEFAULT_SERVER_SETTINGS,
      masterWorkspaceRoot: input.configuredMasterRoot ?? "",
    }),
  });

  const configLayer = ServerConfig.layerTest(input.baseDir, input.baseDir);
  return MasterAssistantService.layer.pipe(
    Layer.provideMerge(projectServiceLayer),
    Layer.provideMerge(serverSettingsLayer),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
  );
}

it.effect("scaffolds master assistant files once without overwriting user edits", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped();
    const layer = makeTestLayer({ baseDir });

    yield* Effect.gen(function* () {
      const master = yield* MasterAssistantService.MasterAssistantService;
      const first = yield* master.ensureMasterProject;
      assert.equal(
        path.resolve(first.workspaceRoot).toLowerCase(),
        path.resolve(baseDir, "master").toLowerCase(),
      );
      assert.isTrue(yield* master.isMasterProject(first.projectId));
      assert.isTrue(yield* master.isMasterPath(first.workspaceRoot));

      for (const file of ["AGENTS.md", "SOUL.md", "USER.md", "MEMORY.md", "DREAM.md"]) {
        assert.isTrue(yield* fs.exists(path.join(first.workspaceRoot, file)));
      }
      assert.isTrue(yield* fs.exists(path.join(first.workspaceRoot, "memory")));

      // Custom user content must never be overwritten on subsequent ensures.
      const soulPath = path.join(first.workspaceRoot, "SOUL.md");
      yield* fs.writeFileString(soulPath, "# Custom Soul\nKeep it concise.\n");

      const second = yield* master.ensureMasterProject;
      assert.equal(second.projectId, first.projectId);
      assert.equal(yield* fs.readFileString(soulPath), "# Custom Soul\nKeep it concise.\n");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("honors custom masterWorkspaceRoot from server settings", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped();
    const customDir = path.join(baseDir, "custom-assistant");
    const layer = makeTestLayer({ baseDir, configuredMasterRoot: customDir });

    yield* Effect.gen(function* () {
      const master = yield* MasterAssistantService.MasterAssistantService;
      const resolvedRoot = yield* master.masterRoot;
      assert.equal(path.resolve(resolvedRoot).toLowerCase(), path.resolve(customDir).toLowerCase());

      const ensured = yield* master.ensureMasterProject;
      assert.isTrue(yield* fs.exists(path.join(ensured.workspaceRoot, "MEMORY.md")));
      assert.isTrue(yield* master.isMasterProject(ensured.projectId));
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("building layerReadOnly first does not poison layer's ProjectService via MemoMap", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped();
    const shared = Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NodeCrypto.layer).pipe(
      Layer.provideMerge(NodeServices.layer),
    );
    const readOnlyConsumer = Layer.effectDiscard(
      MasterAssistantService.MasterAssistantService.pipe(
        Effect.flatMap((master) => master.masterRoot),
      ),
    ).pipe(Layer.provide(MasterAssistantService.layerReadOnly));
    const fullLayer = makeTestLayer({ baseDir });
    const combined = Layer.merge(readOnlyConsumer.pipe(Layer.provide(shared)), fullLayer);

    yield* Effect.gen(function* () {
      const master = yield* MasterAssistantService.MasterAssistantService;
      const ensured = yield* master.ensureMasterProject;
      assert.isTrue(yield* master.isMasterProject(ensured.projectId));
    }).pipe(Effect.provide(combined));
  }).pipe(Effect.provide(NodeServices.layer)),
);
