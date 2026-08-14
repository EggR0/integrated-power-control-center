const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const resourceRoot = path.resolve(__dirname, "..", "src-tauri", "resources");
const nodeRuntime = path.join(resourceRoot, "node-runtime.exe");
const brokerLauncher = path.join(resourceRoot, "broker-server.js");
const port = 37280 + Math.floor(Math.random() * 100);
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "integrated-power-smoke-"));
const claudeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "integrated-power-claude-"));
const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "integrated-power-home-"));
const child = spawn(nodeRuntime, [brokerLauncher], {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, APPDATA: claudeAppData, USERPROFILE: homeRoot, HOME: homeRoot, XDG_CONFIG_HOME: path.join(homeRoot, ".config"), INTEGRATED_POWER_BROKER_PORT: String(port), INTEGRATED_POWER_STATE_ROOT: stateRoot },
});
let output = "";
child.stdout.on("data", (chunk) => { output += String(chunk); });
child.stderr.on("data", (chunk) => { output += String(chunk); });

async function main() {
  try {
    let health;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) { health = await response.json(); break; }
      } catch { /* wait for the bundled broker */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!health?.ok) throw new Error(`Bundled broker did not become healthy. ${output}`);
    const card = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`).then((response) => response.json());
    if (card.supportedInterfaces?.[0]?.protocolBinding !== "HTTP+JSON") throw new Error("A2A v1 HTTP+JSON card was not served.");
    const integrations = await fetch(`http://127.0.0.1:${port}/v1/integrations`).then((response) => response.json());
    if (!Array.isArray(integrations.integrations) || integrations.integrations.length < 3) throw new Error("Host integration status endpoint was not served.");
    const tauriLogsResponse = await fetch(`http://127.0.0.1:${port}/v1/logs?lines=20`, { headers: { origin: "http://tauri.localhost" } });
    if (tauriLogsResponse.headers.get("access-control-allow-origin") !== "http://tauri.localhost") throw new Error("Tauri v2 CORS origin was not allowed.");
    const tauriLogs = await tauriLogsResponse.json();
    if (!Array.isArray(tauriLogs.lines)) throw new Error("Broker log endpoint did not return lines.");
    const registration = await fetch(`http://127.0.0.1:${port}/v1/integrations/claude/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) }).then((response) => response.json());
    if (!registration.changed || !fs.existsSync(registration.configPath)) throw new Error("Claude registration endpoint did not create the selected config.");
    await fetch(`http://127.0.0.1:${port}/v1/integrations/config`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true, chatgptMcpUrl: "https://tunnel.invalid/mcp" }) });
    const configuredIntegrations = await fetch(`http://127.0.0.1:${port}/v1/integrations`).then((response) => response.json());
    if (!configuredIntegrations.integrations.find((item) => item.provider === "openai.chatgpt.app")?.available) throw new Error("ChatGPT MCP configuration was not persisted.");
    console.log(JSON.stringify({ health: health.ok, a2a: card.supportedInterfaces[0].protocolBinding, hostIntegrations: integrations.integrations.length, claudeRegistered: registration.changed, chatgptConfigured: true }));
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once("close", resolve));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { fs.rmSync(stateRoot, { recursive: true, force: true }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    fs.rmSync(claudeAppData, { recursive: true, force: true });
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
