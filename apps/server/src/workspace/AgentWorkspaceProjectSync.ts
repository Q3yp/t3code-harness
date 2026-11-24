import { CommandId, type Project, ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AgentWorkspaceService from "./AgentWorkspaceService.ts";
import { isWithinRoot } from "./KnownWorkspaces.ts";

const SYNC_COOLDOWN_MS = 30_000;

const IGNORED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "__pycache__",
  "dist",
  "build",
  "target",
  "vendor",
  "venv",
  "out",
  "tmp",
  "temp",
]);

const WRAPPER_DIRECTORY_NAMES = new Set(["projects", "works"]);

export class AgentWorkspaceProjectSync extends Context.Service<
  AgentWorkspaceProjectSync,
  {
    readonly syncWorkspace: (workspacePath: string) => Effect.Effect<ReadonlyArray<Project>>;
    readonly syncAll: (options?: {
      readonly force?: boolean;
    }) => Effect.Effect<ReadonlyArray<Project>>;
  }
>()("t3/workspace/AgentWorkspaceProjectSync") {}

const make = Effect.gen(function* () {
  const agentWorkspaces = yield* AgentWorkspaceService.AgentWorkspaceService;
  const projectService = yield* ProjectService.ProjectService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const platform = yield* HostProcess.Platform;
  const syncLock = yield* Semaphore.make(1);
  let nextSyncAllowedAt = 0;

  const normalizeKey = (target: string) => {
    const resolved = path.resolve(target);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };

  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));

  const isDirectory = (target: string) =>
    fileSystem.stat(target).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const realPathOrResolved = (target: string) => {
    const resolved = path.resolve(target);
    return fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
  };

  const listChildDirectories = (folder: string) =>
    fileSystem.readDirectory(folder).pipe(
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
      Effect.flatMap((names) => {
        const candidates = names
          .filter(
            (name) => !name.startsWith(".") && !IGNORED_DIRECTORY_NAMES.has(name.toLowerCase()),
          )
          .toSorted()
          .map((name) => ({ name, fullPath: path.join(folder, name) }));
        return Effect.filter(candidates, (entry) => isDirectory(entry.fullPath), {
          concurrency: 8,
        });
      }),
    );

  const discoverProjectDirectories = Effect.fn(
    "AgentWorkspaceProjectSync.discoverProjectDirectories",
  )(function* (workspacePath: string) {
    const realRoot = yield* realPathOrResolved(workspacePath);
    const directChildren = yield* listChildDirectories(realRoot);
    const discovered: Array<string> = [];

    for (const child of directChildren) {
      if (WRAPPER_DIRECTORY_NAMES.has(child.name.toLowerCase())) {
        const hasOwnMarkers =
          (yield* exists(path.join(child.fullPath, ".git"))) ||
          (yield* exists(path.join(child.fullPath, "AGENTS.md")));
        if (!hasOwnMarkers) {
          const nested = yield* listChildDirectories(child.fullPath);
          for (const nestedChild of nested) {
            discovered.push(nestedChild.fullPath);
          }
          continue;
        }
      }
      discovered.push(child.fullPath);
    }

    const seen = new Set<string>();
    const unique: Array<string> = [];
    for (const candidate of discovered) {
      const real = yield* realPathOrResolved(candidate);
      // Skip symlinks pointing back to the workspace root or above it.
      if (isWithinRoot(path, realRoot, real)) continue;
      const key = normalizeKey(real);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(path.resolve(candidate));
    }
    return unique;
  });

  const syncWorkspaceUnlocked = Effect.fn("AgentWorkspaceProjectSync.syncWorkspaceUnlocked")(
    function* (workspacePath: string) {
      const candidates = yield* discoverProjectDirectories(workspacePath);
      if (candidates.length === 0) return [] as ReadonlyArray<Project>;

      const existingRows = yield* projectStore
        .list({ includeDeleted: true })
        .pipe(Effect.orElseSucceed(() => []));
      const knownRoots = new Set<string>();
      for (const row of existingRows) {
        knownRoots.add(normalizeKey(row.workspaceRoot));
        const real = yield* realPathOrResolved(row.workspaceRoot);
        knownRoots.add(normalizeKey(real));
      }

      const created: Array<Project> = [];
      for (const folderPath of candidates) {
        const key = normalizeKey(folderPath);
        const realKey = normalizeKey(yield* realPathOrResolved(folderPath));
        if (knownRoots.has(key) || knownRoots.has(realKey)) continue;

        const id = yield* random.uuidV4().pipe(Effect.orDie);
        const title = path.basename(folderPath) || "project";
        const result = yield* projectService
          .bootstrap({
            commandId: CommandId.make(`workspace-project:${id}`),
            projectId: ProjectId.make(id),
            title,
            workspaceRoot: folderPath,
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Skipped auto-registering workspace project folder", {
                workspacePath,
                folderPath,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );
        knownRoots.add(key);
        knownRoots.add(realKey);
        if (result !== null && result.created) {
          created.push(result.project);
        }
      }
      return created;
    },
  );

  const syncWorkspace: AgentWorkspaceProjectSync["Service"]["syncWorkspace"] = Effect.fn(
    "AgentWorkspaceProjectSync.syncWorkspace",
  )(function* (workspacePath) {
    return yield* syncLock.withPermits(1)(syncWorkspaceUnlocked(workspacePath));
  });

  const syncAll: AgentWorkspaceProjectSync["Service"]["syncAll"] = Effect.fn(
    "AgentWorkspaceProjectSync.syncAll",
  )(function* (options) {
    return yield* syncLock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (options?.force !== true && now < nextSyncAllowedAt) {
          return [] as ReadonlyArray<Project>;
        }
        nextSyncAllowedAt = now + SYNC_COOLDOWN_MS;
        const catalog = yield* agentWorkspaces
          .list()
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Failed to list agent workspaces for project sync", { cause }).pipe(
                Effect.as({ workspaces: [], errors: [] }),
              ),
            ),
          );
        const created: Array<Project> = [];
        for (const workspace of catalog.workspaces) {
          const synced = yield* syncWorkspaceUnlocked(workspace.path);
          created.push(...synced);
        }
        return created;
      }),
    );
  });

  return AgentWorkspaceProjectSync.of({
    syncWorkspace,
    syncAll,
  });
});

export const layer = Layer.effect(AgentWorkspaceProjectSync, make);
