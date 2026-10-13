const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { resolveBrokerPackage } = require("./broker-package.js");
const { getExtensionRoot } = require("./workspace-paths.js");

if (process.env.INTEGRATED_POWER_BROKER_PACKAGE?.trim()) {
  const brokerPackage = resolveBrokerPackage({ packagePath: process.env.INTEGRATED_POWER_BROKER_PACKAGE });
  console.log(JSON.stringify({ source: brokerPackage.root, brokerVersion: brokerPackage.manifest.brokerVersion, schemaVersion: brokerPackage.manifest.schemaVersion, sourceDigest: brokerPackage.manifest.sourceDigest, reused: true }));
  process.exit(0);
}

const extensionRoot = getExtensionRoot();
const tsc = path.join(extensionRoot, "node_modules", "typescript", "bin", "tsc");
if (!fs.existsSync(tsc)) throw new Error(`Extension TypeScript compiler not found: ${tsc}`);
execFileSync(process.execPath, [tsc, "-p", "."], { cwd: extensionRoot, stdio: "inherit" });
execFileSync(process.execPath, [path.join(extensionRoot, "scripts", "build-broker-package.js")], { cwd: extensionRoot, stdio: "inherit" });
execFileSync(process.execPath, [path.join(extensionRoot, "scripts", "write-broker-manifest.js")], { cwd: extensionRoot, stdio: "inherit" });
const output = path.join(extensionRoot, "out", "broker");
const manifest = JSON.parse(fs.readFileSync(path.join(output, "broker-manifest.json"), "utf8"));
resolveBrokerPackage({ sourcePath: output });
console.log(JSON.stringify({ source: output, brokerVersion: manifest.brokerVersion, schemaVersion: manifest.schemaVersion, sourceDigest: manifest.sourceDigest }));
