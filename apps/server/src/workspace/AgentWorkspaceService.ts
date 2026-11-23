import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import {
  AGENT_WORKSPACE_NAME_PATTERN,
  type AgentWorkspaceCatalog,
  AgentWorkspaceError,
  type AgentWorkspaceName,
  type AgentWorkspaceSummary,
  type ThreadActiveWorkspace,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { parse as parseYaml } from "yaml";

import * as ServerConfig from "../config.ts";

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const isAgentWorkspaceError = Schema.is(AgentWorkspaceError);
const decodeRegistryPaths = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeRegistryPaths = Schema.encodeEffect(fromJsonStringPretty(Schema.Array(Schema.String)));

export interface LiveAgentWorkspace {
  readonly workspace: AgentWorkspaceSummary;
  readonly source: string;
  readonly instructions: string;
}

export class AgentWorkspaceService extends Context.Service<
  AgentWorkspaceService,
  {
    readonly list: () => Effect.Effect<AgentWorkspaceCatalog, AgentWorkspaceError>;
    readonly readLive: (name: string) => Effect.Effect<LiveAgentWorkspace, AgentWorkspaceError>;
    readonly register: (
      inputPath: string,
    ) => Effect.Effect<
      { readonly workspace: AgentWorkspaceSummary; readonly catalog: AgentWorkspaceCatalog },
      AgentWorkspaceError
    >;
    readonly unregister: (
      inputPath: string,
    ) => Effect.Effect<
      { readonly removedPath: string; readonly catalog: AgentWorkspaceCatalog },
      AgentWorkspaceError
    >;
    readonly registeredPaths: () => Effect.Effect<ReadonlyArray<string>>;
    readonly verifyActiveWorkspace: (
      activeWorkspace: ThreadActiveWorkspace,
    ) => Effect.Effect<ThreadActiveWorkspace, AgentWorkspaceError>;
  }
>()("t3/workspace/AgentWorkspaceService") {}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function expandHome(inputPath: string, home: string, path: Path.Path): string {
  const trimmed = inputPath.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(home, trimmed.slice(2));
  }
  return trimmed;
}

function parseWorkspaceAgentsMarkdown(
  source: string,
  instructions: string,
  root: string,
): Effect.Effect<LiveAgentWorkspace, AgentWorkspaceError> {
  return Effect.try({
    try: () => {
      const match = FRONTMATTER_REGEX.exec(instructions);
      if (!match) {
        throw new AgentWorkspaceError({
          code: "invalid_metadata",
          message: `${source}: add YAML frontmatter with name and description`,
        });
      }
      const metadata: unknown = parseYaml(match[1] ?? "");
      if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
        throw new AgentWorkspaceError({
          code: "invalid_metadata",
          message: `${source}: frontmatter must be a mapping`,
        });
      }
      const record = metadata as Record<string, unknown>;
      const rawName = record.name;
      const rawDescription = record.description;
      if (typeof rawName !== "string" || !AGENT_WORKSPACE_NAME_PATTERN.test(rawName)) {
        throw new AgentWorkspaceError({
          code: "invalid_metadata",
          message: `${source}: name must use lowercase words separated by hyphens`,
        });
      }
      if (
        typeof rawDescription !== "string" ||
        rawDescription.trim().length === 0 ||
        /[\r\n]/.test(rawDescription)
      ) {
        throw new AgentWorkspaceError({
          code: "invalid_metadata",
          message: `${source}: description must be one nonempty line`,
        });
      }
      return {
        workspace: {
          name: rawName as AgentWorkspaceName,
          description: rawDescription.trim(),
          path: root,
        },
        source,
        instructions,
      };
    },
    catch: (cause) =>
      isAgentWorkspaceError(cause)
        ? cause
        : new AgentWorkspaceError({
            code: "invalid_metadata",
            message: `${source}: ${formatErrorMessage(cause)}`,
            cause,
          }),
  });
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const mutationLock = yield* Semaphore.make(1);

  const registryPath = path.join(config.stateDir, "workspaces.json");

  const canonicalizeExistingFolder = Effect.fnUntraced(function* (inputPath: string) {
    const expanded = expandHome(inputPath, home, path);
    if (!path.isAbsolute(expanded)) {
      return yield* new AgentWorkspaceError({
        code: "invalid_path",
        message: "Workspace path must be absolute.",
      });
    }
    const resolved = path.resolve(expanded);
    const real = yield* fileSystem.realPath(resolved).pipe(
      Effect.mapError(
        (cause) =>
          new AgentWorkspaceError({
            code: "invalid_path",
            message: `Workspace folder not found: ${resolved}`,
            cause,
          }),
      ),
    );
    const stat = yield* fileSystem.stat(real).pipe(
      Effect.mapError(
        (cause) =>
          new AgentWorkspaceError({
            code: "invalid_path",
            message: `Could not inspect workspace folder: ${real}`,
            cause,
          }),
      ),
    );
    if (stat.type !== "Directory") {
      return yield* new AgentWorkspaceError({
        code: "invalid_path",
        message: `Workspace path is not a directory: ${real}`,
      });
    }
    return real;
  });

  const readWorkspaceFolder = Effect.fnUntraced(function* (folderPath: string) {
    const root = yield* canonicalizeExistingFolder(folderPath);
    const source = path.join(root, "AGENTS.md");
    const instructions = yield* fileSystem.readFileString(source).pipe(
      Effect.mapError(
        (cause) =>
          new AgentWorkspaceError({
            code: "invalid_metadata",
            message: `${source}: could not read AGENTS.md (${formatErrorMessage(cause)})`,
            cause,
          }),
      ),
    );
    return yield* parseWorkspaceAgentsMarkdown(source, instructions, root);
  });

  const readRegistryPaths = Effect.fnUntraced(function* (): Effect.fn.Return<
    ReadonlyArray<string>,
    AgentWorkspaceError
  > {
    const exists = yield* fileSystem.exists(registryPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return [];
    const raw = yield* fileSystem.readFileString(registryPath).pipe(
      Effect.mapError(
        (cause) =>
          new AgentWorkspaceError({
            code: "operation_failed",
            message: `${registryPath}: ${formatErrorMessage(cause)}`,
            cause,
          }),
      ),
    );
    const parsed = yield* decodeRegistryPaths(raw).pipe(
      Effect.mapError(
        (cause) =>
          new AgentWorkspaceError({
            code: "catalog_error",
            message: `${registryPath}: ${formatErrorMessage(cause)}`,
            cause,
          }),
      ),
    );
    if (parsed.some((entry) => !path.isAbsolute(entry))) {
      return yield* new AgentWorkspaceError({
        code: "catalog_error",
        message: `${registryPath}: expected a JSON array of absolute workspace paths`,
      });
    }
    return parsed;
  });

  const writeRegistryPaths = Effect.fnUntraced(function* (entries: ReadonlyArray<string>) {
    yield* fileSystem.makeDirectory(path.dirname(registryPath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new AgentWorkspaceError({
            code: "operation_failed",
            message: `Could not create directory for ${registryPath}: ${formatErrorMessage(cause)}`,
            cause,
          }),
      ),
    );
    const encoded = yield* encodeRegistryPaths(entries).pipe(
      Effect.mapError(
        (cause) =>
          new AgentWorkspaceError({
            code: "operation_failed",
            message: `Could not serialize ${registryPath}: ${formatErrorMessage(cause)}`,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(registryPath, `${encoded}\n`).pipe(
      Effect.mapError(
        (cause) =>
          new AgentWorkspaceError({
            code: "operation_failed",
            message: `Could not save ${registryPath}: ${formatErrorMessage(cause)}`,
            cause,
          }),
      ),
    );
  });

  const readLiveCatalog = Effect.fn("AgentWorkspaceService.readLiveCatalog")(function* () {
    const entries = yield* readRegistryPaths();
    const workspaces: Array<LiveAgentWorkspace> = [];
    const errors: Array<string> = [];
    for (const entryPath of entries) {
      const outcome = yield* Effect.result(readWorkspaceFolder(entryPath));
      if (outcome._tag === "Failure") {
        errors.push(outcome.failure.message);
        continue;
      }
      if (workspaces.some((item) => item.workspace.name === outcome.success.workspace.name)) {
        errors.push(`Duplicate workspace name: ${outcome.success.workspace.name}`);
        continue;
      }
      workspaces.push(outcome.success);
    }
    return { workspaces, errors };
  });

  const list: AgentWorkspaceService["Service"]["list"] = Effect.fn("AgentWorkspaceService.list")(
    function* () {
      const { workspaces, errors } = yield* readLiveCatalog();
      return {
        workspaces: workspaces.map((item) => item.workspace),
        errors,
      };
    },
  );

  const readLive: AgentWorkspaceService["Service"]["readLive"] = Effect.fn(
    "AgentWorkspaceService.readLive",
  )(function* (name) {
    const { workspaces, errors } = yield* readLiveCatalog();
    if (errors.length > 0) {
      return yield* new AgentWorkspaceError({
        code: "catalog_error",
        message: errors.join("\n"),
      });
    }
    const selected = workspaces.find((item) => item.workspace.name === name);
    if (selected === undefined) {
      return yield* new AgentWorkspaceError({
        code: "not_found",
        message: `Workspace not found: ${name}`,
      });
    }
    return selected;
  });

  const pathsMatch = (left: string, right: string) =>
    platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;

  const register: AgentWorkspaceService["Service"]["register"] = Effect.fn(
    "AgentWorkspaceService.register",
  )(function* (inputPath) {
    return yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const live = yield* readWorkspaceFolder(inputPath);
        const canonicalPath = live.workspace.path;
        const entries = yield* readRegistryPaths();

        for (const existingPath of entries) {
          if (pathsMatch(existingPath, canonicalPath)) continue;
          const existing = yield* Effect.result(readWorkspaceFolder(existingPath));
          if (
            existing._tag === "Success" &&
            existing.success.workspace.name === live.workspace.name
          ) {
            return yield* new AgentWorkspaceError({
              code: "duplicate_name",
              message: `Workspace name already registered: ${live.workspace.name}`,
            });
          }
        }

        if (!entries.some((entry) => pathsMatch(entry, canonicalPath))) {
          yield* writeRegistryPaths([...entries, canonicalPath]);
        }

        const catalog = yield* list();
        return { workspace: live.workspace, catalog };
      }),
    );
  });

  const unregister: AgentWorkspaceService["Service"]["unregister"] = Effect.fn(
    "AgentWorkspaceService.unregister",
  )(function* (inputPath) {
    return yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const expanded = expandHome(inputPath, home, path);
        if (!path.isAbsolute(expanded)) {
          return yield* new AgentWorkspaceError({
            code: "invalid_path",
            message: "Workspace path must be absolute.",
          });
        }
        const resolved = path.resolve(expanded);
        const canonical = yield* fileSystem
          .realPath(resolved)
          .pipe(Effect.orElseSucceed(() => resolved));
        const entries = yield* readRegistryPaths();
        const matchIndex = entries.findIndex(
          (entry) =>
            pathsMatch(entry, canonical) ||
            pathsMatch(entry, resolved) ||
            pathsMatch(entry, inputPath.trim()),
        );
        if (matchIndex === -1) {
          return yield* new AgentWorkspaceError({
            code: "not_found",
            message: `Workspace is not registered: ${canonical}`,
          });
        }
        const removedPath = entries[matchIndex]!;
        const nextEntries = entries.filter((_, index) => index !== matchIndex);
        yield* writeRegistryPaths(nextEntries);
        const catalog = yield* list();
        return { removedPath, catalog };
      }),
    );
  });

  const registeredPaths: AgentWorkspaceService["Service"]["registeredPaths"] = () =>
    readRegistryPaths().pipe(Effect.orElseSucceed(() => []));

  const verifyActiveWorkspace: AgentWorkspaceService["Service"]["verifyActiveWorkspace"] =
    Effect.fn("AgentWorkspaceService.verifyActiveWorkspace")(function* (activeWorkspace) {
      const live = yield* readLive(activeWorkspace.name);
      const canonicalInput = yield* canonicalizeExistingFolder(activeWorkspace.path);
      if (!pathsMatch(live.workspace.path, canonicalInput)) {
        return yield* new AgentWorkspaceError({
          code: "invalid_path",
          message: `Workspace '${activeWorkspace.name}' path does not match the registered workspace.`,
        });
      }
      return {
        name: live.workspace.name,
        path: live.workspace.path,
      };
    });

  return AgentWorkspaceService.of({
    list,
    readLive,
    register,
    unregister,
    registeredPaths,
    verifyActiveWorkspace,
  });
});

export const layer = Layer.effect(AgentWorkspaceService, make);
