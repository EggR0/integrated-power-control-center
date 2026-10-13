const path = require("node:path");
const fs = require("node:fs");
const { resolveBrokerPackage } = require("./broker-package.js");
const { getExtensionRoot } = require("./workspace-paths.js");

function getSharedQuotaSource(env = process.env) {
  const explicit = env.INTEGRATED_POWER_SHARED_QUOTA_SOURCE?.trim();
  if (explicit) return path.resolve(explicit);

  const packageInput = env.INTEGRATED_POWER_BROKER_MODULE || env.INTEGRATED_POWER_BROKER_SOURCE || env.INTEGRATED_POWER_BROKER_PACKAGE;
  if (packageInput) {
    const brokerPackage = resolveBrokerPackage({
      modulePath: env.INTEGRATED_POWER_BROKER_MODULE,
      sourcePath: env.INTEGRATED_POWER_BROKER_SOURCE,
      packagePath: env.INTEGRATED_POWER_BROKER_PACKAGE,
    });
    const bundledSource = path.join(brokerPackage.root, "shared-quota-browser.js");
    if (!fs.existsSync(bundledSource)) throw new Error(`Configured broker package has no shared quota bundle: ${bundledSource}`);
    return bundledSource;
  }

  const extensionRoot = getExtensionRoot();
  return path.resolve(extensionRoot, "..", "shared", "quota", "index.ts");
}

module.exports = { getSharedQuotaSource };
