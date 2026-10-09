// Detached disposable broker on 37242 with the FRESHLY compiled out/broker
// and an isolated state root (never touches user state, never 37241).
// The launcher exits immediately; the broker survives (verified pattern).
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const stateRoot = path.join(process.env.LOCALAPPDATA || os.homedir(), "IntegratedPower", "state-e2e-autostart");
fs.mkdirSync(stateRoot, { recursive: true });
const child = spawn(process.execPath, [path.join(__dirname, "broker-server.js")], {
  stdio: "ignore",
  detached: true,
  cwd: __dirname,
  env: {
    ...process.env,
    INTEGRATED_POWER_BROKER_PORT: "37242",
    INTEGRATED_POWER_BROKER_MODULE: path.join(__dirname, "..", "vscode-extension", "out", "broker"),
    INTEGRATED_POWER_STATE_ROOT: stateRoot,
  },
});
child.unref();
console.log("broker 37242 spawned pid=" + child.pid + " state=" + stateRoot);
