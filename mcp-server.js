const fs = require("fs");
const os = require("os");
const path = require("path");
const bundledModule = path.join(__dirname, "broker-out", "broker");
const workspaceModule = path.resolve(__dirname, "..", "vscode-extension", "out", "broker");
const { createPreferredEventLedger, IntegratedPowerBroker, createFirstWaveAdapters, startMcpStdioServer } = require(process.env.INTEGRATED_POWER_BROKER_MODULE || (fs.existsSync(bundledModule) ? bundledModule : workspaceModule));
const stateRoot = process.env.INTEGRATED_POWER_STATE_ROOT || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "IntegratedPower", "state");
fs.mkdirSync(stateRoot, { recursive: true });
(async () => {
  const broker = new IntegratedPowerBroker(createPreferredEventLedger(path.join(stateRoot, "events.enc.jsonl")), createFirstWaveAdapters());
  await broker.initialize();
  startMcpStdioServer(broker);
})().catch((error) => { console.error(error); process.exitCode = 1; });
