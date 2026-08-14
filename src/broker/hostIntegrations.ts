import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AgentCapability, AgentStateKind, ProviderId } from "./protocol";

/**
 * Host integrations are inbound MCP clients. They can create, delegate,
 * review, and cancel tasks through the broker, but the broker must not pretend
 * that it can drive a host GUI or read its conversations. This status object
 * is deliberately based on explicit configuration and a narrow config-file
 * marker, never on credentials.
 */
export interface HostIntegrationStatus {
  provider: ProviderId;
  label: string;
  available: boolean;
  stateKind: AgentStateKind;
  stateLabel: string;
  mode: AgentCapability["mode"];
  capabilities: AgentCapability["capabilities"];
  endpoint?: string;
  configPath?: string;
  reason?: string;
  setup: string;
}

export interface HostIntegrationConfig {
  chatgptMcpUrl?: string;
  claudeMcpUrl?: string;
}

export function inspectHostIntegration(provider: ProviderId): HostIntegrationStatus {
  switch (provider) {
    case "openai.chatgpt.app":
      return inspectChatGpt();
    case "anthropic.claude.desktop":
      return inspectClaudeDesktop();
    case "anthropic.cowork":
      return {
        provider,
        label: "Claude Cowork",
        available: false,
        stateKind: "not_installed",
        stateLabel: "설치X",
        mode: "gui",
        capabilities: ["leader", "remote-mcp", "streaming"],
        reason: "Remote Cowork control is disabled until an official broker bridge is available; no GUI automation or credential reuse is attempted.",
        setup: "Use Claude Desktop local MCP or a future official Cowork bridge.",
      };
    default:
      throw new Error(`Unsupported host integration: ${provider}`);
  }
}

export function listHostIntegrations(): HostIntegrationStatus[] {
  return [
    inspectChatGpt(),
    inspectClaudeDesktop(),
    inspectHostIntegration("anthropic.cowork"),
  ];
}

function isChatGptInstalled(): boolean {
  if (process.platform === "win32") {
    const homedir = os.homedir();
    const local = process.env.LOCALAPPDATA || path.join(homedir, "AppData", "Local");
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const candidates = [
      path.join(local, "Programs", "ChatGPT", "ChatGPT.exe"),
      path.join(programFiles, "ChatGPT", "ChatGPT.exe"),
      path.join(local, "OpenAI", "Codex"),
      path.join(homedir, ".codex"),
    ];
    if (candidates.some((c) => fs.existsSync(c))) return true;
    const packagesDir = path.join(local, "Packages");
    try {
      if (fs.existsSync(packagesDir)) {
        const entries = fs.readdirSync(packagesDir);
        if (entries.some((e) => e.startsWith("OpenAI.ChatGPT") || e.startsWith("OpenAI.Codex"))) return true;
      }
    } catch { /* best effort */ }
  }
  if (process.platform === "darwin") return fs.existsSync("/Applications/ChatGPT.app");
  return false;
}

function isClaudeInstalled(): boolean {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const candidates = [
      path.join(local, "Programs", "Claude", "Claude.exe"),
      path.join(programFiles, "Claude", "Claude.exe"),
      path.join(appData, "Claude"),
      path.join(appData, "Claude", "claude_desktop_config.json"),
    ];
    return candidates.some((c) => fs.existsSync(c));
  }
  if (process.platform === "darwin") return fs.existsSync("/Applications/Claude.app");
  return fs.existsSync("/usr/bin/claude") || fs.existsSync("/usr/local/bin/claude");
}

function inspectChatGpt(): HostIntegrationStatus {
  const config = readHostIntegrationConfig();
  const explicitEndpoint = (process.env.INTEGRATED_POWER_CHATGPT_MCP_URL || config.chatgptMcpUrl)?.trim();
  const installed = isChatGptInstalled();

  let localMcpConfigured = false;
  let detectedEndpoint = explicitEndpoint;
  try {
    const configPath = path.join(os.homedir(), ".codex", "config.toml");
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf8");
      if (/\[mcp_servers\.(?:integrated-power|"integrated-power")\]/i.test(content) || /37241\/mcp/i.test(content)) {
        localMcpConfigured = true;
        const urlMatch = content.match(/url\s*=\s*["']([^"']+)["']/);
        if (urlMatch && urlMatch[1]) detectedEndpoint = urlMatch[1];
      }
    }
  } catch { /* best effort */ }

  const isConfigured = Boolean(localMcpConfigured || (explicitEndpoint && /^https?:\/\//i.test(explicitEndpoint)));

  let stateKind: AgentStateKind = "not_installed";
  let stateLabel = "설치X";
  let reason: string | undefined = "ChatGPT 데스크톱 앱이 설치되어 있지 않습니다.";

  if (isConfigured) {
    stateKind = "available";
    stateLabel = "사용가능";
    reason = undefined;
  } else if (installed) {
    stateKind = "unlinked";
    stateLabel = "연동X";
    reason = "ChatGPT 데스크톱이 설치되어 있습니다. 맞춤형 MCP에서 'http://127.0.0.1:37241/mcp'로 연결하세요.";
  }

  return {
    provider: "openai.chatgpt.app",
    label: "ChatGPT desktop/web MCP app",
    available: isConfigured,
    stateKind,
    stateLabel,
    mode: "gui",
    capabilities: ["leader", "remote-mcp", "streaming"],
    endpoint: detectedEndpoint || (isConfigured ? "http://127.0.0.1:37241/mcp" : undefined),
    reason,
    setup: "ChatGPT 맞춤형 MCP에 'http://127.0.0.1:37241/mcp'를 등록하여 로컬 브로커와 연동합니다.",
  };
}

function inspectClaudeDesktop(): HostIntegrationStatus {
  const config = readHostIntegrationConfig();
  const remoteEndpoint = (process.env.INTEGRATED_POWER_CLAUDE_MCP_URL || config.claudeMcpUrl)?.trim();
  const installed = isClaudeInstalled();

  if (remoteEndpoint && /^https:\/\//i.test(remoteEndpoint)) {
    return {
      provider: "anthropic.claude.desktop",
      label: "Claude Desktop remote MCP connector",
      available: true,
      stateKind: "available",
      stateLabel: "사용가능",
      mode: "gui",
      capabilities: ["leader", "remote-mcp", "streaming"],
      endpoint: remoteEndpoint,
      setup: "Add the HTTPS MCP endpoint under Claude Desktop Settings > Connectors.",
    };
  }

  const configPath = claudeDesktopConfigPath();
  const configured = fs.existsSync(configPath) && containsIntegratedPowerMarker(configPath);

  let stateKind: AgentStateKind = "not_installed";
  let stateLabel = "설치X";
  let reason: string | undefined = "Claude Desktop 앱이 설치되어 있지 않습니다.";

  if (configured) {
    stateKind = "available";
    stateLabel = "사용가능";
    reason = undefined;
  } else if (installed) {
    stateKind = "unlinked";
    stateLabel = "연동X";
    reason = "Claude Desktop이 설치되어 있습니다. [자동 등록] 버튼을 눌러 MCP를 연동하세요.";
  }

  return {
    provider: "anthropic.claude.desktop",
    label: "Claude Desktop local MCP",
    available: configured,
    stateKind,
    stateLabel,
    mode: "gui",
    capabilities: ["leader", "local-mcp", "streaming"],
    configPath,
    reason,
    setup: "Claude Desktop 설정에 integrated-power MCP 서버를 추가합니다.",
  };
}

export function readHostIntegrationConfig(): HostIntegrationConfig {
  const stateRoot = process.env.INTEGRATED_POWER_STATE_ROOT;
  if (!stateRoot) return {};
  try {
    const value = JSON.parse(fs.readFileSync(path.join(stateRoot, "integrations.json"), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as HostIntegrationConfig : {};
  } catch {
    return {};
  }
}

export function saveHostIntegrationConfig(input: HostIntegrationConfig, confirm: boolean): HostIntegrationConfig {
  if (!confirm) throw new Error("Explicit confirmation is required before changing host integration settings.");
  const stateRoot = process.env.INTEGRATED_POWER_STATE_ROOT;
  if (!stateRoot) throw new Error("Integrated Power state root is not available.");
  const next: HostIntegrationConfig = { ...readHostIntegrationConfig() };
  if (Object.prototype.hasOwnProperty.call(input, "chatgptMcpUrl")) {
    if (input.chatgptMcpUrl) next.chatgptMcpUrl = validateRemoteMcpUrl(input.chatgptMcpUrl, "ChatGPT");
    else delete next.chatgptMcpUrl;
  }
  if (Object.prototype.hasOwnProperty.call(input, "claudeMcpUrl")) {
    if (input.claudeMcpUrl) next.claudeMcpUrl = validateRemoteMcpUrl(input.claudeMcpUrl, "Claude");
    else delete next.claudeMcpUrl;
  }
  fs.mkdirSync(stateRoot, { recursive: true });
  const target = path.join(stateRoot, "integrations.json");
  const temp = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
  return next;
}

function validateRemoteMcpUrl(value: string, label: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${label} MCP URL must be a valid HTTPS URL.`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} MCP URL must be HTTPS without embedded credentials or query tokens.`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export function claudeDesktopConfigPath(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Claude", "claude_desktop_config.json");
}

function containsIntegratedPowerMarker(filePath: string): boolean {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return /integrated[-_ ]?power/i.test(text);
  } catch {
    return false;
  }
}
