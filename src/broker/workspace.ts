import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface IsolatedWorkspace {
  root: string;
  branch: string;
  basePath: string;
}

export async function createIsolatedWorkspace(
  basePath: string,
  taskId: string,
  workRoot: string,
): Promise<IsolatedWorkspace> {
  const resolvedBase = path.resolve(basePath);
  const resolvedWorkRoot = path.resolve(workRoot);
  await fs.promises.mkdir(resolvedWorkRoot, { recursive: true });
  const safeTaskId = taskId.replace(/[^A-Za-z0-9._-]/g, "-");
  const root = path.join(resolvedWorkRoot, safeTaskId);
  const branch = `integrated-power/${safeTaskId}`;
  await fs.promises.mkdir(root, { recursive: true });
  try {
    await execFileAsync("git", ["-C", resolvedBase, "worktree", "add", "-b", branch, root, "HEAD"], {
      windowsHide: true,
      timeout: 30_000,
    });
  } catch (error) {
    await fs.promises.rm(root, { recursive: true, force: true });
    throw new Error(`Unable to create isolated Git worktree: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { root, branch, basePath: resolvedBase };
}

export async function removeIsolatedWorkspace(workspace: IsolatedWorkspace): Promise<void> {
  await execFileAsync("git", ["-C", workspace.basePath, "worktree", "remove", "--force", workspace.root], {
    windowsHide: true,
    timeout: 30_000,
  });
}

export async function mergeIsolatedWorkspace(workspace: IsolatedWorkspace): Promise<{ commit: string }> {
  await execFileAsync("git", ["-C", workspace.root, "diff", "--check"], { windowsHide: true, timeout: 30_000 });
  await execFileAsync("git", ["-C", workspace.basePath, "merge", "--no-ff", workspace.branch, "-m", `Integrated Power merge ${workspace.branch}`], {
    windowsHide: true,
    timeout: 60_000,
  });
  const result = await execFileAsync("git", ["-C", workspace.basePath, "rev-parse", "HEAD"], { windowsHide: true, timeout: 10_000 });
  return { commit: String(result.stdout).trim() };
}

export async function abortBaseMerge(basePath: string): Promise<void> {
  await execFileAsync("git", ["-C", path.resolve(basePath), "merge", "--abort"], { windowsHide: true, timeout: 30_000 }).catch(() => undefined);
}
