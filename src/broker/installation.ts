import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ProviderId } from "./protocol";
import { listHostIntegrations } from "./hostIntegrations";
import { findExecutableOnPath } from "./executable";

export interface InstallationProbe {
  provider: ProviderId;
  label: string;
  detected: boolean;
  executablePath?: string;
  configPath?: string;
  registration: "configured" | "user-selection-required" | "not-applicable";
  reason?: string;
}

/** Detect only well-known installation locations and PATH entries. This is a
 * read-only preflight for the installer; it never scans unrelated folders or
 * changes app configuration. */
export function discoverInstallations(): InstallationProbe[] {
  const hosts = listHostIntegrations();
  const claude = hosts.find((item) => item.provider === "anthropic.claude.desktop");
  return [
    executableProbe("google.antigravity.ide", "Antigravity IDE / Agy", ["agy.exe", "agy.cmd", "agy"]),
    executableProbe("openai.codex.app", "Codex App Server", ["codex.exe", "codex.cmd", "codex"]),
    applicationProbe("openai.chatgpt.app", "ChatGPT desktop", chatGptPaths(), "user-selection-required", "ChatGPT uses an approved remote MCP app; no local executable is required for the broker host bridge."),
    {
      provider: "anthropic.claude.desktop",
      label: "Claude Desktop",
      detected: claude?.available === true || claudeAppPaths().some((candidate) => fs.existsSync(candidate)),
      configPath: claude?.configPath,
      registration: claude?.available ? "configured" : "user-selection-required",
      reason: claude?.reason || "Select local MCP registration in Claude Desktop, then restart it.",
    },
    applicationProbe("anthropic.cowork", "Claude Cowork", [], "user-selection-required", "Remote Cowork remains disabled until an official broker bridge is available."),
    applicationProbe("xai.grok", "xAI Grok", [], "user-selection-required", "Grok GUI registration is deferred; configure an approved xAI API separately if needed."),
  ];
}

function executableProbe(provider: ProviderId, label: string, names: string[]): InstallationProbe {
  const executablePath = findExecutableOnPath(names);
  return {
    provider,
    label,
    detected: Boolean(executablePath),
    executablePath,
    registration: executablePath ? "user-selection-required" : "not-applicable",
    reason: executablePath ? "Detected; installation or MCP registration requires explicit user selection." : `${label} was not found in known PATH entries.`,
  };
}

function applicationProbe(provider: ProviderId, label: string, candidates: string[], registration: InstallationProbe["registration"], reason: string): InstallationProbe {
  const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
  return { provider, label, detected: Boolean(executablePath), executablePath, registration, reason };
}

function chatGptPaths(): string[] {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return [path.join(local, "Programs", "ChatGPT", "ChatGPT.exe")];
  }
  if (process.platform === "darwin") return ["/Applications/ChatGPT.app"];
  return [];
}

function claudeAppPaths(): string[] {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    return [path.join(local, "Programs", "Claude", "Claude.exe"), path.join(programFiles, "Claude", "Claude.exe")];
  }
  if (process.platform === "darwin") return ["/Applications/Claude.app"];
  return ["/usr/bin/claude", "/usr/local/bin/claude"];
}
