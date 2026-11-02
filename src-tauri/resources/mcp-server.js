const fs = require("fs");
const os = require("os");
const path = require("path");
const bundledModule = fs.existsSync(path.join(__dirname, "broker-out", "broker", "broker-manifest.json"))
  ? path.join(__dirname, "broker-out", "broker")
  : path.join(__dirname, "src-tauri", "resources", "broker-out", "broker");
const { resolveBrokerPackage } = require("./scripts/broker-package.js");
const brokerPackage = resolveBrokerPackage({
  modulePath: process.env.INTEGRATED_POWER_BROKER_MODULE,
  sourcePath: process.env.INTEGRATED_POWER_BROKER_SOURCE,
  packagePath: process.env.INTEGRATED_POWER_BROKER_PACKAGE || bundledModule,
});
const { prepareCanonicalBrokerLedger, configureBrokerAssets } = require("./scripts/canonical-broker-state.js");
configureBrokerAssets(brokerPackage, process.env);
const { IntegratedPowerBroker, createFirstWaveAdapters, startMcpStdioServer } = require(brokerPackage.entrypointPath);
const stateRoot = process.env.INTEGRATED_POWER_STATE_ROOT || process.env.INTEGRATED_POWER_STATE_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "IntegratedPower", "state");
process.env.INTEGRATED_POWER_STATE_ROOT = stateRoot;
fs.mkdirSync(stateRoot, { recursive: true });
(async () => {
  const { ledger } = await prepareCanonicalBrokerLedger(brokerPackage, stateRoot);
  const broker = new IntegratedPowerBroker(ledger, createFirstWaveAdapters());
  await broker.initialize();
  startMcpStdioServer(broker);
})().catch((error) => { console.error(error); process.exitCode = 1; });
