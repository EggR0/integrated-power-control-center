const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveBrokerPackage } = require("./broker-package.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ip-broker-package-"));
try {
  const stale = makePackage("0.9.20", 1, ["runs.read"]);
  const current = makePackage("0.9.21", 2, ["runs.read", "metrics.localLlm.read", "quota.settings.read", "quota.notifications.claim"]);

  assert.equal(
    resolveBrokerPackage({ sourcePath: current, packagePath: stale }).manifest.brokerVersion,
    "0.9.21",
    "an explicit source checkout must take precedence over a packaged fallback",
  );
  assert.throws(
    () => resolveBrokerPackage({ modulePath: stale, sourcePath: current }),
    /schemaVersion|capabilit/i,
    "an invalid explicit runtime package must fail instead of falling through",
  );
  assert.throws(
    () => resolveBrokerPackage({ packagePath: path.join(root, "missing-package") }),
    /manifest|package|broker/i,
    "missing canonical package must fail without selecting an unversioned legacy bundle",
  );

  const corrupted = makePackage("0.9.22", 2, ["runs.read", "metrics.localLlm.read", "quota.settings.read", "quota.notifications.claim"]);
  fs.appendFileSync(path.join(corrupted, "index.js"), "\n// changed after manifest generation\n");
  assert.throws(
    () => resolveBrokerPackage({ packagePath: corrupted }),
    /digest/i,
    "a package changed after manifest generation must not launch",
  );

  console.log("Broker package resolution tests passed.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function makePackage(version, schemaVersion, capabilities) {
  const directory = path.join(root, `${version}-${schemaVersion}`);
  fs.mkdirSync(directory, { recursive: true });
  const assetRoot = path.join(directory, "resources");
  fs.mkdirSync(path.join(assetRoot, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(assetRoot, "assets", "ip-orchestrator-plugin", "skills", "ip-orchestrator", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(assetRoot, "scripts", "read-agy-credential.ps1"), "# fixture\n");
  for (const script of ["Select-LocalLLMModel.ps1", "Invoke-LocalLLM.ps1", "Invoke-vLLMJob.ps1"]) fs.writeFileSync(path.join(assetRoot, "assets", "ip-orchestrator-plugin", "skills", "ip-orchestrator", "scripts", script), "# fixture\n");
  fs.writeFileSync(path.join(directory, "index.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(directory, "helper.js"), "exports.ready = true;\n");
  fs.writeFileSync(path.join(directory, "broker-manifest.json"), JSON.stringify({
    brokerVersion: version,
    schemaVersion,
    capabilities,
    entrypoint: "index.js",
    assetRoot: "resources",
    sourceDigest: digest(directory),
  }));
  return directory;
}

function digest(directory) {
  const hash = crypto.createHash("sha256");
  for (const file of listJavaScript(directory).sort()) {
    hash.update(path.relative(directory, file).split(path.sep).join("/"));
    hash.update(Buffer.from([0]));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}

function listJavaScript(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJavaScript(file);
    return entry.isFile() && entry.name.endsWith(".js") ? [file] : [];
  });
}
