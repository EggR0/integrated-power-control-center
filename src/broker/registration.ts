import * as fs from "fs";
import * as path from "path";
import { claudeDesktopConfigPath } from "./hostIntegrations";

export interface ClaudeRegistrationResult {
  configPath: string;
  backupPath?: string;
  changed: boolean;
  spec: { command: string; args: string[]; env: Record<string, string> };
}

/** Resolve the physical path to mcp-server.js across build and standalone layouts. */
export function resolveMcpServerScript(): string {
  if (process.env.INTEGRATED_POWER_MCP_SERVER?.trim()) {
    return path.resolve(process.env.INTEGRATED_POWER_MCP_SERVER.trim());
  }
  const candidates = [
    path.resolve(__dirname, "../../../control-center/mcp-server.js"),
    path.resolve(__dirname, "../../control-center/mcp-server.js"),
    path.resolve(__dirname, "../control-center/mcp-server.js"),
    path.resolve(process.cwd(), "control-center/mcp-server.js"),
    path.resolve(__dirname, "mcpServer.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

/** Return the exact MCP launch entry used by Claude Desktop. It points at the
 * currently running broker distribution and does not include credentials. */
export function claudeLocalMcpSpec(): { command: string; args: string[]; env: Record<string, string> } {
  const serverPath = resolveMcpServerScript();
  return {
    command: process.execPath,
    args: [serverPath],
    env: {
      INTEGRATED_POWER_STATE_ROOT: process.env.INTEGRATED_POWER_STATE_ROOT || "",
    },
  };
}

/** Return the exact MCP launch entry formatted for ChatGPT Desktop / developer connectors. */
export function chatgptLocalMcpSpec(): { command: string; args: string[]; env: Record<string, string> } {
  return claudeLocalMcpSpec();
}

/** Return a standard mcpServers object suitable for direct copying into settings. */
export function getMcpConfigSnippet(serverName = "integrated-power"): { mcpServers: Record<string, any> } {
  return {
    mcpServers: {
      [serverName]: claudeLocalMcpSpec(),
    },
  };
}

/**
 * Merge the Integrated Power MCP entry into Claude Desktop's config only after
 * an explicit UI confirmation. Existing JSON and unrelated MCP servers are
 * preserved; a timestamped backup is made before the atomic replacement.
 */
export function registerClaudeLocalMcp(confirm: boolean, configPath = claudeDesktopConfigPath()): ClaudeRegistrationResult {
  if (!confirm) throw new Error("Explicit confirmation is required before changing Claude Desktop configuration.");
  const spec = claudeLocalMcpSpec();
  const parent = path.dirname(configPath);
  fs.mkdirSync(parent, { recursive: true });
  let config: Record<string, any> = {};
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Claude Desktop config must be a JSON object.");
    config = parsed;
  }
  const servers = config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers) ? config.mcpServers : {};
  const previous = JSON.stringify(servers["integrated-power"]);
  servers["integrated-power"] = spec;
  config.mcpServers = servers;
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  if (previous === JSON.stringify(spec)) return { configPath, changed: false, spec };
  const backupPath = fs.existsSync(configPath) ? `${configPath}.integrated-power.bak-${Date.now()}` : undefined;
  if (backupPath) fs.copyFileSync(configPath, backupPath);
  const tempPath = `${configPath}.integrated-power.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tempPath, serialized, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, configPath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* best-effort temp cleanup */ }
    throw error;
  }
  return { configPath, backupPath, changed: true, spec };
}
