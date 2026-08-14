import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

export interface WorkspaceContext {
  text: string;
  files: string[];
  omittedFiles: string[];
  truncated: boolean;
}

const DEFAULT_MAX_CHARS = 12_000;
const ALLOWED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".ps1"]);
const IGNORED_SEGMENTS = new Set(["node_modules", "out", "dist", ".git", ".vscode-test"]);

export function buildWorkspaceContext(
  workspacePath: string,
  requestedFiles: string[] = [],
  maxChars = DEFAULT_MAX_CHARS,
): WorkspaceContext {
  const root = path.resolve(workspacePath);
  const candidates = requestedFiles.length ? requestedFiles : changedFiles(root);
  const files = unique(candidates.map((file) => resolveWithinRoot(root, file)).filter(Boolean) as string[])
    .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile())
    .filter((file) => ALLOWED_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .filter((file) => !isIgnored(root, file));
  const included: string[] = [];
  const omittedFiles: string[] = [];
  const sections: string[] = [];
  let remaining = Math.max(1_000, Math.floor(maxChars));
  let truncated = false;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const relative = path.relative(root, file).replace(/\\/g, "/");
    const content = redactSecrets(fs.readFileSync(file, "utf8"));
    const section = `===== ${relative} =====\n${content}\n`;
    if (section.length <= remaining) {
      sections.push(section);
      included.push(relative);
      remaining -= section.length;
      continue;
    }
    if (remaining > 200) {
      sections.push(`===== ${relative} (truncated) =====\n${content.slice(0, remaining - 80)}\n...[truncated]\n`);
      included.push(relative);
      truncated = true;
      omittedFiles.push(...files.slice(index + 1).map((candidate) => path.relative(root, candidate).replace(/\\/g, "/")));
      remaining = 0;
      break;
    }
    omittedFiles.push(relative);
    remaining = 0;
    break;
  }
  return { text: sections.join("\n"), files: included, omittedFiles, truncated };
}

function changedFiles(root: string): string[] {
  try {
    const output = execFileSync("git", ["-C", root, "status", "--porcelain=v1"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const files = output.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).map((line) => {
      const raw = line.slice(2).trim();
      const rename = raw.includes(" -> ") ? raw.split(" -> ").pop()! : raw;
      return rename.replace(/^"|"$/g, "");
    });
    return files.sort((left, right) => sourcePriority(left) - sourcePriority(right));
  } catch {
    return [];
  }
}

function sourcePriority(file: string): number {
  return /\.(ts|tsx|js|mjs|cjs|ps1)$/i.test(file) ? 0 : /\.json$/i.test(file) ? 1 : 2;
}

function resolveWithinRoot(root: string, file: string): string | undefined {
  const resolved = path.resolve(root, file);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return resolved;
}

function isIgnored(root: string, file: string): boolean {
  const relative = path.relative(root, file).split(path.sep);
  return relative.some((segment) => IGNORED_SEGMENTS.has(segment));
}

function redactSecrets(value: string): string {
  return value
    .replace(/(api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|token|password|secret)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9]{12,}\b/g, "sk-[redacted]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[private-key redacted]");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
