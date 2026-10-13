// `npm run dev` = vite (5173) + the product broker (37241), one command.
// The broker launcher (broker-server.js) mirrors the Tauri shell: if a broker
// is already on 37241 (the IDE extension's), it attaches and exits; otherwise
// it starts its own. Either way the web app's default port works out of the
// box — no ?broker= needed.
const { spawn } = require("child_process");
const path = require("path");
const { resolveBrokerPackage } = require("./broker-package.js");
const { getSharedQuotaSource } = require("./shared-quota-source.js");

const root = path.join(__dirname, "..");
const packagePath = process.env.INTEGRATED_POWER_BROKER_PACKAGE || path.join(root, "broker-out", "broker");
const sourcePath = process.env.INTEGRATED_POWER_BROKER_SOURCE;
const brokerPackage = resolveBrokerPackage({
  modulePath: process.env.INTEGRATED_POWER_BROKER_MODULE,
  sourcePath,
  packagePath: process.env.INTEGRATED_POWER_BROKER_MODULE || sourcePath ? undefined : packagePath,
});
const vite = spawn(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1"], {
  stdio: "inherit",
  cwd: root,
  env: { ...process.env, INTEGRATED_POWER_SHARED_QUOTA_SOURCE: getSharedQuotaSource() },
});
const broker = spawn(process.execPath, [path.join(root, "broker-server.js")], {
  stdio: "inherit",
  cwd: root,
  env: { ...process.env, INTEGRATED_POWER_BROKER_MODULE: brokerPackage.root },
});

let done = false;
function kill(proc) {
  try { proc.kill("SIGTERM"); } catch { /* already gone */ }
}
function shutdown(code) {
  if (done) return;
  done = true;
  kill(vite);
  kill(broker);
  process.exit(code);
}

vite.on("exit", (code) => { if (!done) { kill(broker); process.exit(code ?? 1); } });
broker.on("exit", (code) => {
  // Attaching to an existing (IDE) broker exits 0 — nothing to do.
  if (code && code !== 0) console.error("[dev] broker exited with " + code + " — web app will show broker offline");
});
process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(0));
