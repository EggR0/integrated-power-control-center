const path = require("node:path");
const { resolveBrokerPackage } = require("./broker-package.js");
const { getExtensionRoot } = require("./workspace-paths.js");

const root = path.resolve(__dirname, "..");
const broker = resolveBrokerPackage({
  modulePath: process.env.INTEGRATED_POWER_BROKER_MODULE,
  sourcePath: process.env.INTEGRATED_POWER_BROKER_SOURCE,
  packagePath: process.env.INTEGRATED_POWER_BROKER_PACKAGE || path.join(getExtensionRoot(), "out", "broker"),
});
console.log(JSON.stringify({ broker: broker.manifest, entrypoint: broker.entrypointPath }));
