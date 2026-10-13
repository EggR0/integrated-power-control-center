// Lightweight standalone launcher used by the Tauri control center in local
// development and packaging smoke tests. The VSIX and this launcher share the
// same broker implementation; no GUI credentials are read.
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const bundledModule = path.join(__dirname, "broker-out", "broker");
const { resolveBrokerPackage } = require("./scripts/broker-package.js");
const brokerPackage = resolveBrokerPackage({
  modulePath: process.env.INTEGRATED_POWER_BROKER_MODULE,
  sourcePath: process.env.INTEGRATED_POWER_BROKER_SOURCE,
  packagePath: process.env.INTEGRATED_POWER_BROKER_PACKAGE || bundledModule,
});
const { prepareCanonicalBrokerLedger, configureBrokerAssets } = require("./scripts/canonical-broker-state.js");
configureBrokerAssets(brokerPackage, process.env);
const { IntegratedPowerBroker, createFirstWaveAdapters, startBrokerServer } = require(brokerPackage.entrypointPath);

// The VSIX storagePath module defines the canonical product state root. Keep
// the standalone Tauri launcher on that same root so tasks, approvals and
// telemetry are restored by either host instead of being split by UI.
const stateRoot = process.env.INTEGRATED_POWER_STATE_ROOT || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "IntegratedPower", "state");
process.env.INTEGRATED_POWER_MCP_SERVER ||= path.join(__dirname, "mcp-server.js");
fs.mkdirSync(stateRoot, { recursive: true });
const port = Number.parseInt(process.env.INTEGRATED_POWER_BROKER_PORT || "37241", 10);
(async () => {
  if (await probeBroker(port)) {
    console.log(JSON.stringify({ service: "integrated-power-broker", port, bind: "127.0.0.1", attached: true }));
    return;
  }
  const { ledger } = await prepareCanonicalBrokerLedger(brokerPackage, stateRoot);
  const broker = new IntegratedPowerBroker(ledger, createFirstWaveAdapters());
  await broker.initialize();
  let server;
  try {
    server = await startBrokerServer(broker, Number.isFinite(port) && port > 0 ? port : 37241, { stateRoot });
  } catch (error) {
    if (!isAddressInUse(error) || !(await probeBroker(port))) throw error;
    console.log(JSON.stringify({ service: "integrated-power-broker", port, bind: "127.0.0.1", attached: true }));
    return;
  }
  console.log(JSON.stringify({ service: "integrated-power-broker", port: server.port, bind: "127.0.0.1", stateRoot }));
  const shutdown = () => void server.close().finally(() => process.exit(0));
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
})().catch((error) => { console.error(error); process.exitCode = 1; });

function probeBroker(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 500 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try { resolve(response.statusCode === 200 && JSON.parse(body).service === "integrated-power-broker"); }
        catch { resolve(false); }
      });
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => { request.destroy(); resolve(false); });
  });
}

function isAddressInUse(error) {
  return Boolean(error && typeof error === "object" && error.code === "EADDRINUSE");
}
