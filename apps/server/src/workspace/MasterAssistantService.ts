import { CommandId, ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";

const MASTER_DEFAULT_DIR_NAME = "master";

export class MasterAssistantError extends Schema.TaggedError<MasterAssistantError>()(
  "MasterAssistantError",
  {
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const detail =
      this.cause instanceof Error
        ? this.cause.message
        : typeof this.cause === "string"
          ? this.cause
          : "";
    return detail
      ? `Failed to prepare Master assistant folder at ${this.workspaceRoot}: ${detail}`
      : `Failed to prepare Master assistant folder at ${this.workspaceRoot}.`;
  }
}

const masterFolderRoot = (baseDir: string, path: Path.Path) =>
  path.resolve(baseDir, MASTER_DEFAULT_DIR_NAME);

function expandHome(inputPath: string, home: string, path: Path.Path): string {
  const trimmed = inputPath.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(home, trimmed.slice(2));
  }
  return trimmed;
}

const DEFAULT_MASTER_FILES: ReadonlyArray<{
  readonly relativePath: string;
  readonly content: string;
}> = [
  {
    relativePath: "AGENTS.md",
    content: `# Master Assistant

You are the user's persistent personal assistant inside T3 Code.

## Operating Files

- \`SOUL.md\`: identity, communication tone, and core principles.
- \`USER.md\`: durable preferences, context, and workflows about the user.
- \`MEMORY.md\` & \`memory/\`: durable cross-domain memory and topic notes.
- \`DREAM.md\`: rules used during \`/dream\` memory consolidation passes.

Read these files when relevant, and keep them concise and accurate.

## Routing & Delegation

1. Answer quick questions, planning, triage, and light synthesis directly in this thread.
2. For substantive work in a domain or codebase:
   - Check \`t3_project_list\` and \`t3_thread_list\` (\`allProjects: true\`) to see if a relevant active thread already exists.
   - Continue an active thread with \`t3_thread_send\`, or launch a new visible top-level thread with \`t3_thread_launch\` (passing \`workspace\` from \`<agent_workspaces>\` and/or \`projectId\`).
   - Always include the clickable thread \`link\` in your reply so the user can inspect or take over anytime.
3. Keep this Master thread rooted in this folder; do not switch its own working root with \`workspace_activate\`.
`,
  },
  {
    relativePath: "SOUL.md",
    content: `# Soul

- Be direct, calm, observant, and genuinely helpful.
- Match the user's language and level of detail; lead with the answer or action.
- Preserve context across sessions without being verbose or ceremonial.
- Respect boundaries: ask before destructive or irreversible external actions.
`,
  },
  {
    relativePath: "USER.md",
    content: `# User Profile & Preferences

Record durable facts, preferred tools, communication preferences, and recurring workflows here.
`,
  },
  {
    relativePath: "MEMORY.md",
    content: `# Memory

Durable cross-project facts, decisions, ongoing themes, and links to deeper notes under \`memory/\`.
`,
  },
  {
    relativePath: "DREAM.md",
    content: `# Dream Consolidation

You are running a \`/dream\` side pass to consolidate memory and assistant documents in this workspace.

1. Review the handed-off conversation context (and optionally check recent threads via \`t3_thread_list\` / \`t3_thread_read\` if relevant).
2. Distill durable facts, preferences, decisions, and recurring lessons into \`MEMORY.md\`, \`memory/\`, and \`USER.md\`.
3. Deduplicate, prune outdated entries, and keep files crisp and easy to scan.
4. Only adjust \`SOUL.md\` or \`AGENTS.md\` when the user explicitly asked for a behavioral change or a clear pattern warrants it.
5. Do not continue the main thread's active task; finish with a short summary of the files updated.
`,
  },
];

export class MasterAssistantService extends Context.Service<
  MasterAssistantService,
  {
    readonly masterRoot: Effect.Effect<string>;
    readonly ensureMasterProject: Effect.Effect<
      { readonly projectId: ProjectId; readonly workspaceRoot: string },
      MasterAssistantError
    >;
    readonly isMasterProject: (projectId: ProjectId) => Effect.Effect<boolean>;
    readonly isMasterPath: (folderPath: string) => Effect.Effect<boolean>;
  }
>()("t3/workspace/MasterAssistantService") {}

const makeWithProjects = Effect.fn("MasterAssistantService.makeWithProjects")(function* (
  projects: ProjectService.ProjectService["Service"] | undefined,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const random = yield* SecureRandom.SecureRandom;
  const projectStore = Option.getOrUndefined(
    yield* Effect.serviceOption(ProjectStore.ProjectStoreV2),
  );
  const serverSettings = Option.getOrUndefined(
    yield* Effect.serviceOption(ServerSettings.ServerSettingsService),
  );

  const normalizeKey = (target: string) => {
    const resolved = path.resolve(target);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };

  const resolveConfiguredRoot: Effect.Effect<string> = Effect.gen(function* () {
    const configured =
      serverSettings === undefined
        ? ""
        : yield* serverSettings.getSettings.pipe(
            Effect.map((settings) => settings.masterWorkspaceRoot.trim()),
            Effect.orElseSucceed(() => ""),
          );
    if (configured.length > 0) {
      const expanded = expandHome(configured, home, path);
      if (path.isAbsolute(expanded)) {
        return path.resolve(expanded);
      }
      return path.resolve(config.baseDir, expanded);
    }
    return masterFolderRoot(config.baseDir, path);
  });

  const canonicalRoot = (root: string) =>
    fileSystem.realPath(root).pipe(
      Effect.flatMap((target) =>
        target === root || projects === undefined
          ? Effect.succeed(root)
          : projects
              .getByWorkspaceRoot(target)
              .pipe(Effect.map((project) => (Option.isSome(project) ? target : root))),
      ),
      Effect.orElseSucceed(() => root),
    );

  const masterRoot: MasterAssistantService["Service"]["masterRoot"] = resolveConfiguredRoot.pipe(
    Effect.flatMap(canonicalRoot),
  );

  const scaffoldMissingFiles = Effect.fn("MasterAssistantService.scaffoldMissingFiles")(function* (
    workspaceRoot: string,
  ) {
    yield* fileSystem
      .makeDirectory(workspaceRoot, { recursive: true })
      .pipe(Effect.mapError((cause) => new MasterAssistantError({ workspaceRoot, cause })));
    yield* fileSystem
      .makeDirectory(path.join(workspaceRoot, "memory"), { recursive: true })
      .pipe(Effect.mapError((cause) => new MasterAssistantError({ workspaceRoot, cause })));
    for (const file of DEFAULT_MASTER_FILES) {
      const fullPath = path.join(workspaceRoot, file.relativePath);
      const exists = yield* fileSystem.exists(fullPath).pipe(Effect.orElseSucceed(() => false));
      if (exists) continue;
      yield* fileSystem
        .writeFileString(fullPath, file.content)
        .pipe(Effect.mapError((cause) => new MasterAssistantError({ workspaceRoot, cause })));
    }
  });

  const ensureMasterProject: MasterAssistantService["Service"]["ensureMasterProject"] = Effect.gen(
    function* () {
      const configuredRoot = yield* resolveConfiguredRoot;
      yield* scaffoldMissingFiles(configuredRoot);
      const workspaceRoot = yield* canonicalRoot(configuredRoot);
      if (projects === undefined) {
        return yield* new MasterAssistantError({
          workspaceRoot,
          cause: "ProjectService is unavailable.",
        });
      }
      const id = yield* random
        .uuidV4()
        .pipe(Effect.mapError((cause) => new MasterAssistantError({ workspaceRoot, cause })));
      const bootstrapped = yield* projects
        .bootstrap({
          commandId: CommandId.make(`master-project:${id}`),
          projectId: ProjectId.make(id),
          title: "Master",
          workspaceRoot,
        })
        .pipe(
          Effect.catchTags({
            ProjectConflictError: (conflict) =>
              Effect.succeed({
                project: { id: conflict.conflictingProjectId },
                created: false,
              }),
          }),
          Effect.mapError((cause) => new MasterAssistantError({ workspaceRoot, cause })),
        );
      if (bootstrapped.created) {
        yield* projects
          .update({
            commandId: CommandId.make(`master-project-icon:${id}`),
            projectId: bootstrapped.project.id,
            projectIcon: { kind: "lucide", name: "bot", color: "violet" },
          })
          .pipe(Effect.mapError((cause) => new MasterAssistantError({ workspaceRoot, cause })));
      }
      return { projectId: bootstrapped.project.id, workspaceRoot };
    },
  );

  const isMasterPath: MasterAssistantService["Service"]["isMasterPath"] = Effect.fn(
    "MasterAssistantService.isMasterPath",
  )(function* (folderPath) {
    const root = yield* masterRoot;
    if (normalizeKey(folderPath) === normalizeKey(root)) return true;
    const realCandidate = yield* fileSystem
      .realPath(path.resolve(folderPath))
      .pipe(Effect.orElseSucceed(() => path.resolve(folderPath)));
    const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
    return normalizeKey(realCandidate) === normalizeKey(realRoot);
  });

  const isMasterProject: MasterAssistantService["Service"]["isMasterProject"] = Effect.fn(
    "MasterAssistantService.isMasterProject",
  )(function* (projectId) {
    const workspaceRoot =
      projectStore !== undefined
        ? yield* projectStore.get(projectId).pipe(
            Effect.map(Option.map((project) => project.workspaceRoot)),
            Effect.orElseSucceed(() => Option.none<string>()),
          )
        : projects !== undefined
          ? yield* projects.getById(projectId).pipe(
              Effect.map(Option.map((project) => project.workspaceRoot)),
              Effect.orElseSucceed(() => Option.none<string>()),
            )
          : Option.none<string>();
    return Option.isSome(workspaceRoot) ? yield* isMasterPath(workspaceRoot.value) : false;
  });

  return MasterAssistantService.of({
    masterRoot,
    ensureMasterProject,
    isMasterProject,
    isMasterPath,
  });
});

/** Full layer with ProjectService required so `ensureMasterProject` is always wired. */
export const layer = Layer.effect(
  MasterAssistantService,
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    return yield* makeWithProjects(projects);
  }),
);

/**
 * Separate layer instance for read-only consumers (KnownWorkspaces, RuntimePolicy) that only check
 * `masterRoot` / `isMasterPath` without pulling in `ProjectService` or colliding in Layer's MemoMap.
 */
export const layerReadOnly = Layer.effect(
  MasterAssistantService,
  Effect.suspend(() => makeWithProjects(undefined)),
);
