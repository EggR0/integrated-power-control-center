const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BROKER_MANIFEST = "broker-manifest.json";
const REQUIRED_CAPABILITIES = ["runs.read", "metrics.localLlm.read", "quota.settings.read", "quota.notifications.claim"];

function resolveBrokerPackage({ modulePath, sourcePath, packagePath, expectedSchemaVersion = 2 } = {}) {
  const selectedPath = modulePath || sourcePath || packagePath;
  if (typeof selectedPath !== "string" || !selectedPath.trim()) {
    throw new Error("No canonical broker package is configured.");
  }
  return validateBrokerPackage(selectedPath, { expectedSchemaVersion });
}

function validateBrokerPackage(bundlePath, { expectedSchemaVersion = 2, requiredCapabilities = REQUIRED_CAPABILITIES } = {}) {
  const root = path.resolve(bundlePath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Broker package directory not found: ${root}`);
  }

  const manifestPath = path.join(root, BROKER_MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Broker package manifest is missing or invalid: ${error.message}`);
  }

  if (typeof manifest.brokerVersion !== "string" || !manifest.brokerVersion.trim()) {
    throw new Error("Broker package manifest has no brokerVersion.");
  }
  if (manifest.schemaVersion !== expectedSchemaVersion) {
    throw new Error(`Broker package schemaVersion ${manifest.schemaVersion} is incompatible; expected ${expectedSchemaVersion}.`);
  }
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.some((item) => typeof item !== "string")) {
    throw new Error("Broker package manifest has invalid capabilities.");
  }
  for (const capability of requiredCapabilities) {
    if (!manifest.capabilities.includes(capability)) {
      throw new Error(`Broker package is missing required capability: ${capability}.`);
    }
  }
  if (manifest.entrypoint !== "index.js") {
    throw new Error("Broker package entrypoint must be index.js.");
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.sourceDigest || "")) {
    throw new Error("Broker package manifest has an invalid sourceDigest.");
  }

  if (typeof manifest.assetRoot !== "string" || !manifest.assetRoot.trim()) {
    throw new Error("Broker package manifest has no assetRoot.");
  }
  const assetRootPath = path.resolve(root, manifest.assetRoot);
  if (!fs.existsSync(assetRootPath) || !fs.statSync(assetRootPath).isDirectory()) {
    throw new Error(`Broker package assetRoot not found: ${assetRootPath}`);
  }
  for (const relative of ["scripts/read-agy-credential.ps1", "assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts/Select-LocalLLMModel.ps1", "assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts/Invoke-LocalLLM.ps1", "assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts/Invoke-vLLMJob.ps1"]) {
    if (!fs.existsSync(path.join(assetRootPath, relative))) throw new Error(`Broker package is missing required policy asset: ${relative}`);
  }

  const entrypointPath = path.resolve(root, manifest.entrypoint);
  const relativeEntrypoint = path.relative(root, entrypointPath);
  if (!relativeEntrypoint || relativeEntrypoint.startsWith(`..${path.sep}`) || path.isAbsolute(relativeEntrypoint)) {
    throw new Error("Broker package entrypoint must stay inside its package directory.");
  }
  if (!fs.existsSync(entrypointPath) || !fs.statSync(entrypointPath).isFile()) {
    throw new Error(`Broker package entrypoint not found: ${entrypointPath}`);
  }
  if (hashBrokerFiles(root, assetRootPath) !== manifest.sourceDigest) {
    throw new Error("Broker package sourceDigest does not match its JavaScript files.");
  }

  return { root, entrypointPath, manifestPath, manifest };
}

function hashBrokerFiles(root, assetRootPath) {
  const hash = crypto.createHash("sha256");
  const files = listJavaScriptFiles(root, assetRootPath).sort((left, right) => {
    const leftRelative = path.relative(root, left).split(path.sep).join("/");
    const rightRelative = path.relative(root, right).split(path.sep).join("/");
    return leftRelative < rightRelative ? -1 : leftRelative > rightRelative ? 1 : 0;
  });
  for (const file of files) {
    const relativePath = path.relative(root, file).split(path.sep).join("/");
    hash.update(relativePath);
    hash.update(Buffer.from([0]));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}

function listJavaScriptFiles(directory, excludedRoot) {
  if (excludedRoot && path.resolve(directory) === path.resolve(excludedRoot)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(file, excludedRoot);
    return entry.isFile() && entry.name.endsWith(".js") ? [file] : [];
  });
}

module.exports = { BROKER_MANIFEST, REQUIRED_CAPABILITIES, resolveBrokerPackage, validateBrokerPackage };
