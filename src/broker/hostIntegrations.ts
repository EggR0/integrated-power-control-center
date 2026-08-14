import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AgentCapability, ProviderId } from "./protocol";

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

function inspectChatGpt(): HostIntegrationStatus {
  const config = readHostIntegrationConfig();
  const endpoint = (process.env.INTEGRATED_POWER_CHATGPT_MCP_URL || config.chatgptMcpUrl)?.trim();
  const validRemote = Boolean(endpoint && /^https:\/\//i.test(endpoint));
  return {
    provider: "openai.chatgpt.app",
    label: "ChatGPT desktop/web MCP app",
    available: validRemote,
    mode: "gui",
    capabilities: ["leader", "remote-mcp", "streaming"],
    endpoint: validRemote ? endpoint : undefined,
    reason: validRemote
      ? undefined
      : "ChatGPT custom MCP apps require a user-approved remote HTTPS MCP endpoint. A loopback server is not exposed automatically; configure a Secure MCP Tunnel URL explicitly.",
    setup: "Create/enable an approved MCP app in ChatGPT and set INTEGRATED_POWER_CHATGPT_MCP_URL to its HTTPS tunnel URL.",
  };
}

function inspectClaudeDesktop(): HostIntegrationStatus {
  const config = readHostIntegrationConfig();
  const remoteEndpoint = (process.env.INTEGRATED_POWER_CLAUDE_MCP_URL || config.claudeMcpUrl)?.trim();
  if (remoteEndpoint && /^https:\/\//i.test(remoteEndpoint)) {
    return {
      provider: "anthropic.claude.desktop",
      label: "Claude Desktop remote MCP connector",
      available: true,
      mode: "gui",
      capabilities: ["leader", "remote-mcp", "streaming"],
      endpoint: remoteEndpoint,
      setup: "Add the HTTPS MCP endpoint under Claude Desktop Settings > Connectors.",
    };
  }

  const configPath = claudeDesktopConfigPath();
  const configured = fs.existsSync(configPath) && containsIntegratedPowerMarker(configPath);
  return {
    provider: "anthropic.claude.desktop",
    label: "Claude Desktop local MCP",
    available: configured,
    mode: "gui",
    capabilities: ["leader", "local-mcp", "streaming"],
    configPath,
    reason: configured ? undefined : "Claude Desktop local MCP is not configured for Integrated Power.",
    setup: "Add the provided integrated-power MCP server to Claude Desktop, then restart Claude Desktop.",
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
