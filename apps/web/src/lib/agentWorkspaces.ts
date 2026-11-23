import type {
  AgentWorkspaceSummary,
  EnvironmentId,
  ThreadActiveWorkspace,
} from "@t3tools/contracts";

const WORKSPACE_SCOPE_PREFIX = "agent-workspace:";

function normalizeWorkspacePath(value: string): string {
  const replaced = value.trim().replaceAll("\\", "/");
  const stripped = replaced.length > 1 ? replaced.replace(/\/+$/u, "") : replaced;
  // Windows drive paths (e.g. C:/...) compare case-insensitively.
  return /^[A-Za-z]:\//u.test(stripped) ? stripped.toLowerCase() : stripped;
}

export function workspacePathsEqual(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  return normalizeWorkspacePath(left) === normalizeWorkspacePath(right);
}

export function isPathWithinWorkspace(candidatePath: string, workspacePath: string): boolean {
  const candidate = normalizeWorkspacePath(candidatePath);
  const root = normalizeWorkspacePath(workspacePath);
  if (candidate === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return candidate.startsWith(prefix);
}

export function findContainingAgentWorkspace<T extends Pick<AgentWorkspaceSummary, "path">>(
  folderPath: string | null | undefined,
  workspaces: ReadonlyArray<T>,
): T | null {
  if (!folderPath) return null;
  let best: T | null = null;
  let bestLength = -1;
  for (const workspace of workspaces) {
    if (!isPathWithinWorkspace(folderPath, workspace.path)) continue;
    const length = normalizeWorkspacePath(workspace.path).length;
    if (length > bestLength) {
      best = workspace;
      bestLength = length;
    }
  }
  return best;
}

export function encodeWorkspaceScopeKey(
  environmentId: EnvironmentId,
  workspacePath: string,
): string {
  return `${WORKSPACE_SCOPE_PREFIX}${environmentId}:${normalizeWorkspacePath(workspacePath)}`;
}

export function isWorkspaceScopeKey(key: string): boolean {
  return key.startsWith(WORKSPACE_SCOPE_PREFIX);
}

export function parseWorkspaceScopeKey(
  key: string,
): { readonly environmentId: EnvironmentId; readonly normalizedPath: string } | null {
  if (!key.startsWith(WORKSPACE_SCOPE_PREFIX)) return null;
  const rest = key.slice(WORKSPACE_SCOPE_PREFIX.length);
  const separatorIndex = rest.indexOf(":");
  if (separatorIndex <= 0) return null;
  const environmentId = rest.slice(0, separatorIndex) as EnvironmentId;
  const normalizedPath = rest.slice(separatorIndex + 1);
  if (!normalizedPath) return null;
  return { environmentId, normalizedPath };
}

export function activeWorkspaceFromSummary(
  workspace: Pick<AgentWorkspaceSummary, "name" | "path">,
): ThreadActiveWorkspace {
  return { name: workspace.name, path: workspace.path };
}
