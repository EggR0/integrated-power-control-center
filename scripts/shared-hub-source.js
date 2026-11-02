const path = require("node:path");
const fs = require("node:fs");
const { resolveBrokerPackage } = require("./broker-package.js");
const { getExtensionRoot } = require("./workspace-paths.js");

function getSharedHubSource(env = process.env) {
  const explicit = env.INTEGRATED_POWER_SHARED_HUB_SOURCE?.trim();
  if (explicit) return path.resolve(explicit);

  const packageInput = env.INTEGRATED_POWER_BROKER_MODULE || env.INTEGRATED_POWER_BROKER_SOURCE || env.INTEGRATED_POWER_BROKER_PACKAGE;
  if (packageInput) {
    const brokerPackage = resolveBrokerPackage({
      modulePath: env.INTEGRATED_POWER_BROKER_MODULE,
      sourcePath: env.INTEGRATED_POWER_BROKER_SOURCE,
      packagePath: env.INTEGRATED_POWER_BROKER_PACKAGE,
    });
    const bundledSource = path.join(brokerPackage.root, "shared-hub-browser.js");
    if (!fs.existsSync(bundledSource)) {
      throw new Error(`Configured broker package has no shared hub bundle: ${bundledSource}`);
    }
    return bundledSource;
  }

  const extensionRoot = getExtensionRoot();
  return path.resolve(extensionRoot, "..", "shared", "hub", "index.ts");
}

module.exports = { getSharedHubSource };
