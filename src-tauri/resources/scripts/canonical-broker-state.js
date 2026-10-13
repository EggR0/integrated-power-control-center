const fs = require("node:fs");
const path = require("node:path");

async function prepareCanonicalBrokerLedger(brokerPackage, stateRoot, env = process.env, keyAccess = {}) {
  const {
    createPreferredEventLedger,
    getCanonicalBrokerLedgerPath,
    loadExistingLedgerKey,
    loadOrCreateLedgerKey,
    migrateBrokerLedgers,
  } = require(brokerPackage.entrypointPath);
  if (typeof getCanonicalBrokerLedgerPath !== "function" || typeof migrateBrokerLedgers !== "function") {
    throw new Error("The selected broker package cannot resolve or migrate the canonical ledger; startup was refused.");
  }
  const canonicalBase = getCanonicalBrokerLedgerPath(stateRoot);
  const canonicalPath = existingLedgerPath(canonicalBase);
  const legacyBases = [path.join(stateRoot, "events.enc.jsonl"), ...knownIdeGlobalStorageRoots(env).map((root) => path.join(root, "broker", "events.enc.jsonl"))];
  const sourcePaths = [...new Set(legacyBases.flatMap(existingCandidates))].filter((candidate) => path.resolve(candidate) !== path.resolve(canonicalPath));
  const sources = sourcePaths.map((sourcePath) => {
    const key = (keyAccess.loadExistingLedgerKey || loadExistingLedgerKey)(`${sourcePath}.key`);
    if (!key) throw new Error(`Legacy broker ledger key is unavailable for ${sourcePath}; both ledger and state were preserved.`);
    return { path: sourcePath, key };
  });
  let canonicalKey;
  await migrateBrokerLedgers(sources, canonicalPath, (destinationPath, exists) => {
    canonicalKey = exists
      ? (keyAccess.loadExistingLedgerKey || loadExistingLedgerKey)(`${destinationPath}.key`)
      : (keyAccess.loadOrCreateLedgerKey || loadOrCreateLedgerKey)(`${canonicalBase}.key`);
    if (!canonicalKey) throw new Error(`Canonical broker ledger key is unavailable for ${destinationPath}; state was preserved.`);
    return canonicalKey;
  });
  if (!canonicalKey) {
    canonicalKey = fs.existsSync(canonicalPath)
      ? (keyAccess.loadExistingLedgerKey || loadExistingLedgerKey)(`${canonicalPath}.key`)
      : (keyAccess.loadOrCreateLedgerKey || loadOrCreateLedgerKey)(`${canonicalBase}.key`);
  }
  if (!canonicalKey) throw new Error(`Canonical broker ledger key is unavailable for ${canonicalPath}; state was preserved.`);
  const ledger = createPreferredEventLedger(canonicalBase, canonicalKey);
  configureBrokerAssets(brokerPackage, env);
  return { ledger, canonicalPath, assetRoot: env.INTEGRATED_POWER_BROKER_ASSET_ROOT };
}

function existingCandidates(basePath) {
  const candidates = [basePath, `${basePath}.jsonl`].filter((candidate) => fs.existsSync(candidate));
  if (candidates.length > 1) throw new Error(`Multiple broker ledger formats exist beside ${basePath}; all files were preserved.`);
  return candidates;
}

function existingLedgerPath(basePath) {
  return existingCandidates(basePath)[0] || basePath;
}

function knownIdeGlobalStorageRoots(env) {
  const roots = [];
  if (env.INTEGRATED_POWER_IDE_GLOBAL_STORAGE?.trim()) roots.push(path.resolve(env.INTEGRATED_POWER_IDE_GLOBAL_STORAGE.trim()));
  for (const userDataDir of [env.ANTIGRAVITY_USER_DATA_DIR, env.VSCODE_USER_DATA_DIR]) {
    if (userDataDir?.trim()) roots.push(path.join(path.resolve(userDataDir.trim()), "User", "globalStorage", "EggR0.integrated-power"));
  }
  if (env.APPDATA?.trim()) {
    for (const product of ["Antigravity", "Antigravity IDE", "Code", "Code - Insiders"]) {
      roots.push(path.join(path.resolve(env.APPDATA), product, "User", "globalStorage", "EggR0.integrated-power"));
    }
  }
  return [...new Set(roots)];
}

function configureBrokerAssets(brokerPackage, env) {
  const relative = brokerPackage.manifest.assetRoot;
  if (typeof relative !== "string" || !relative.trim()) throw new Error("Broker package manifest is missing assetRoot.");
  const assetRoot = env.INTEGRATED_POWER_BROKER_ASSET_ROOT?.trim()
    ? path.resolve(env.INTEGRATED_POWER_BROKER_ASSET_ROOT.trim())
    : path.resolve(brokerPackage.root, relative);
  if (!fs.existsSync(assetRoot) || !fs.statSync(assetRoot).isDirectory()) throw new Error(`Broker assetRoot is missing: ${assetRoot}`);
  for (const relativePath of ["scripts/read-agy-credential.ps1", "assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts/Select-LocalLLMModel.ps1", "assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts/Invoke-LocalLLM.ps1", "assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts/Invoke-vLLMJob.ps1"]) {
    if (!fs.existsSync(path.join(assetRoot, relativePath))) throw new Error(`Broker assetRoot is missing required policy asset ${relativePath}: ${assetRoot}`);
  }
  env.INTEGRATED_POWER_BROKER_ASSET_ROOT = assetRoot;
  const packageModules = path.join(assetRoot, "node_modules");
  if (fs.existsSync(packageModules)) {
    const module = require("node:module");
    env.NODE_PATH = [packageModules, env.NODE_PATH].filter(Boolean).join(path.delimiter);
    module.Module._initPaths();
  }
  const localScripts = path.join(assetRoot, "assets", "ip-orchestrator-plugin", "skills", "ip-orchestrator", "scripts");
  if (fs.existsSync(localScripts) && fs.statSync(localScripts).isDirectory()) env.INTEGRATED_POWER_LOCAL_SCRIPTS = localScripts;
}

module.exports = { prepareCanonicalBrokerLedger, knownIdeGlobalStorageRoots, configureBrokerAssets };
