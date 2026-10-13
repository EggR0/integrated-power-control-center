const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { getExtensionRoot } = require("./workspace-paths.js");

const root = path.resolve(__dirname, "..");
const packagedResources = path.join(root, "src-tauri", "resources");
const bundledBroker = path.join(packagedResources, "broker-out", "broker");
const sourceBroker = path.join(getExtensionRoot(), "out", "broker");
const { EncryptedEventLedger, IntegratedPowerBroker } = require(path.join(sourceBroker, "index.js"));
const temp = fs.mkdtempSync(path.join(path.resolve(__dirname, ".."), ".tmp-canonical-launcher-"));

async function main() {
  const isolated = path.join(temp, "source-inaccessible-runtime");
  const runtimeBroker = path.join(isolated, "broker-out", "broker");
  fs.mkdirSync(path.dirname(runtimeBroker), { recursive: true });
  fs.cpSync(bundledBroker, runtimeBroker, { recursive: true });
  fs.cpSync(path.join(packagedResources, "scripts"), path.join(isolated, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(packagedResources, "broker-server.js"), path.join(isolated, "broker-server.js"));
  fs.copyFileSync(path.join(packagedResources, "mcp-server.js"), path.join(isolated, "mcp-server.js"));
  fs.cpSync(path.join(packagedResources, "node_modules"), path.join(isolated, "node_modules"), { recursive: true });
  const sourceAssetRoot = path.resolve(sourceBroker, JSON.parse(fs.readFileSync(path.join(sourceBroker, "broker-manifest.json"), "utf8")).assetRoot);
  const packagedAssetRoot = path.join(runtimeBroker, "resources");
  for (const relative of [
    "scripts/read-agy-credential.ps1",
    "assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts/Select-LocalLLMModel.ps1",
    "assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts/Invoke-LocalLLM.ps1",
    "assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts/Invoke-vLLMJob.ps1",
  ]) {
    assert.deepEqual(fs.readFileSync(path.join(packagedAssetRoot, relative)), fs.readFileSync(path.join(sourceAssetRoot, relative)), `portable package preserves exact policy asset bytes: ${relative}`);
  }

  const stateRoot = path.join(temp, "state");
  const desktopLegacy = path.join(stateRoot, "events.enc.jsonl");
  const appData = path.join(temp, "AppData");
  const ideStorage = path.join(appData, "Antigravity IDE", "User", "globalStorage", "EggR0.integrated-power");
  const ideLegacy = path.join(ideStorage, "broker", "events.enc.jsonl");
  const desktopKey = Buffer.alloc(32, 21);
  const ideKey = Buffer.alloc(32, 22);
  fs.mkdirSync(path.dirname(desktopLegacy), { recursive: true });
  fs.mkdirSync(path.dirname(ideLegacy), { recursive: true });
  fs.writeFileSync(`${desktopLegacy}.key`, desktopKey);
  fs.writeFileSync(`${ideLegacy}.key`, ideKey);
  const desktopLedger = new EncryptedEventLedger(desktopLegacy, desktopKey);
  const desktopBroker = new IntegratedPowerBroker(desktopLedger, []);
  await desktopBroker.initialize();
  const task = await desktopBroker.createTask({ title: "paired launcher history", goal: "preserve canonical state", originProvider: "local.openai-compatible", privacy: "private" });
  const existingEvents = await desktopLedger.list();
  const ideLedger = new EncryptedEventLedger(ideLegacy, ideKey);
  for (const event of existingEvents) await ideLedger.append(event);
  const ideBroker = new IntegratedPowerBroker(ideLedger, []);
  await ideBroker.initialize();
  await ideBroker.recordEvidence({ taskId: task.id, kind: "runtime", label: "IDE source continuation", passed: true, details: "legacy source remained appendable", expectedRevision: task.revision, idempotencyKey: "ide-source-continuation" });

  const { resolveBrokerPackage } = require(path.join(isolated, "scripts", "broker-package.js"));
  const { knownIdeGlobalStorageRoots, prepareCanonicalBrokerLedger } = require(path.join(isolated, "scripts", "canonical-broker-state.js"));
  const explicitStorage = path.join(temp, "explicit-global-storage");
  const antigravityUserData = path.join(temp, "antigravity-user-data");
  const vscodeUserData = path.join(temp, "vscode-user-data");
  assert.deepEqual(knownIdeGlobalStorageRoots({
    INTEGRATED_POWER_IDE_GLOBAL_STORAGE: explicitStorage,
    ANTIGRAVITY_USER_DATA_DIR: antigravityUserData,
    VSCODE_USER_DATA_DIR: vscodeUserData,
    APPDATA: appData,
  }), [
    explicitStorage,
    path.join(antigravityUserData, "User", "globalStorage", "EggR0.integrated-power"),
    path.join(vscodeUserData, "User", "globalStorage", "EggR0.integrated-power"),
    path.join(appData, "Antigravity", "User", "globalStorage", "EggR0.integrated-power"),
    path.join(appData, "Antigravity IDE", "User", "globalStorage", "EggR0.integrated-power"),
    path.join(appData, "Code", "User", "globalStorage", "EggR0.integrated-power"),
    path.join(appData, "Code - Insiders", "User", "globalStorage", "EggR0.integrated-power"),
  ], "explicit override and existing Antigravity locations keep precedence before the Antigravity IDE product path");
  const runtimePackage = resolveBrokerPackage({ packagePath: runtimeBroker });
  const testKeyAccess = {
    loadExistingLedgerKey(filePath) { try { const key = fs.readFileSync(filePath); return key.length === 32 ? key : undefined; } catch { return undefined; } },
    loadOrCreateLedgerKey(filePath) {
      try { return fs.readFileSync(filePath); } catch { const key = Buffer.alloc(32, 23); fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, key); return key; }
    },
  };
  const isolatedEnv = { ...process.env, APPDATA: appData };
  const canonical = await prepareCanonicalBrokerLedger(runtimePackage, stateRoot, isolatedEnv, testKeyAccess);

  const port = await freePort();
  const userProfile = path.join(temp, "profile");
  fs.mkdirSync(userProfile, { recursive: true });
  const env = {
    ...process.env,
    USERPROFILE: userProfile,
    HOME: userProfile,
    LOCALAPPDATA: path.join(userProfile, "localappdata"),
    APPDATA: appData,
    INTEGRATED_POWER_STATE_ROOT: stateRoot,
    INTEGRATED_POWER_BROKER_PORT: String(port),
    INTEGRATED_POWER_BROKER_PACKAGE: runtimeBroker,
  };
  const first = spawn(process.execPath, [path.join(isolated, "broker-server.js")], { cwd: temp, env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await waitForHealth(port, first);
    const health = await getJson(port, "/health");
    const tasks = await getJson(port, "/v1/tasks");
    assert.equal(health.schemaVersion, 2);
    assert.ok(health.capabilities.includes("quota.notifications.claim"));
    assert.ok(tasks.tasks.some((entry) => entry.id === task.id && entry.revision === task.revision + 1), "desktop launcher merged and exposed the longer IDE source history");
    assert.equal(canonical.canonicalPath, path.join(stateRoot, "broker", "events.enc.jsonl"));
    assert.ok(fs.existsSync(canonical.canonicalPath), "canonical ledger was created");
    assert.ok(fs.existsSync(desktopLegacy) && fs.existsSync(ideLegacy), "source ledgers remain intact after migration");
  } finally {
    await stop(first);
  }

  const restarted = spawn(process.execPath, [path.join(isolated, "broker-server.js")], { cwd: temp, env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await waitForHealth(port, restarted);
    const tasks = await getJson(port, "/v1/tasks");
    assert.ok(tasks.tasks.some((entry) => entry.id === task.id), "restart reads the same migrated canonical ledger");
  } finally {
    await stop(restarted);
  }

  const mcp = spawn(process.execPath, [path.join(isolated, "mcp-server.js")], { cwd: temp, env, stdio: ["pipe", "pipe", "pipe"] });
  try {
    const output = await mcpRequest(mcp, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.ok(output.includes("integrated_power_list_tasks"), "MCP launcher starts using the same canonical ledger package");
  } finally {
    await stop(mcp);
  }

  process.stdout.write(JSON.stringify({ port, taskId: task.id, canonicalLedger: path.join(stateRoot, "broker", "events.enc.jsonl"), httpRestartContinuity: true, mcpStarted: true }));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(port, child) {
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Broker launcher exited ${child.exitCode}: ${stderr}`);
    try {
      const value = await getJson(port, "/health");
      if (value.service === "integrated-power-broker") return;
    } catch { /* startup is still in progress */ }
    await delay(100);
  }
  throw new Error(`Broker launcher did not become healthy: ${stderr}`);
}

function getJson(port, route) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: route, timeout: 1500 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { reject(error); }
      });
    }).on("error", reject);
  });
}

function mcpRequest(child, request) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`MCP startup timed out: ${output}`)), 10000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
      if (output.includes("integrated_power_list_tasks")) { clearTimeout(timeout); resolve(output); }
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timeout = setTimeout(() => child.kill(), 3000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
    child.kill();
  });
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(temp, { recursive: true, force: true }));
