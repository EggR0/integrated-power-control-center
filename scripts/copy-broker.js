const fs = require("fs");
const path = require("path");
const { resolveBrokerPackage } = require("./broker-package.js");
const { getExtensionRoot } = require("./workspace-paths.js");
const root = path.resolve(__dirname, "..");
const configuredPackagePath = process.env.INTEGRATED_POWER_BROKER_PACKAGE?.trim();
let extensionRoot;
if (!configuredPackagePath) extensionRoot = getExtensionRoot();
else {
  try { extensionRoot = getExtensionRoot(); } catch { /* a versioned broker package is self-contained */ }
}
const packagePath = configuredPackagePath || path.join(extensionRoot, "out", "broker");
const source = resolveBrokerPackage({
  modulePath: process.env.INTEGRATED_POWER_BROKER_MODULE,
  sourcePath: process.env.INTEGRATED_POWER_BROKER_SOURCE,
  packagePath,
}).root;
const destination = path.resolve(__dirname, "..", "src-tauri", "resources", "broker-out", "broker");
const resourceRoot = path.resolve(__dirname, "..", "src-tauri", "resources");
const runtimeModules = path.join(resourceRoot, "node_modules");
if (!fs.existsSync(source)) throw new Error(`Compiled broker not found: ${source}`);
fs.rmSync(destination, { recursive: true, force: true });
fs.rmSync(runtimeModules, { recursive: true, force: true });
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.cpSync(source, destination, { recursive: true });
const sourceManifest = JSON.parse(fs.readFileSync(path.join(source, "broker-manifest.json"), "utf8"));
const sourceAssetRoot = path.resolve(source, sourceManifest.assetRoot);
const assetsDestination = path.join(destination, "resources");
fs.mkdirSync(assetsDestination, { recursive: true });
copyRequired(path.join(sourceAssetRoot, "scripts", "read-agy-credential.ps1"), path.join(assetsDestination, "scripts", "read-agy-credential.ps1"));
copyRequired(path.join(sourceAssetRoot, "assets"), path.join(assetsDestination, "assets"), true);
const copiedManifestPath = path.join(destination, "broker-manifest.json");
const copiedManifest = JSON.parse(fs.readFileSync(copiedManifestPath, "utf8"));
copiedManifest.assetRoot = "resources";
fs.writeFileSync(copiedManifestPath, `${JSON.stringify(copiedManifest, null, 2)}\n`);
fs.copyFileSync(path.resolve(__dirname, "..", "broker-server.js"), path.join(resourceRoot, "broker-server.js"));
fs.copyFileSync(path.resolve(__dirname, "..", "mcp-server.js"), path.join(resourceRoot, "mcp-server.js"));
fs.mkdirSync(path.join(resourceRoot, "scripts"), { recursive: true });
fs.copyFileSync(path.join(__dirname, "broker-package.js"), path.join(resourceRoot, "scripts", "broker-package.js"));
fs.copyFileSync(path.join(__dirname, "canonical-broker-state.js"), path.join(resourceRoot, "scripts", "canonical-broker-state.js"));
// Keep a stable executable filename. Windows CreateProcess requires an
// executable extension; Unix treats the .exe suffix as an ordinary filename.
fs.rmSync(path.join(resourceRoot, "node-runtime"), { force: true });
const bundledNode = path.join(resourceRoot, "node-runtime.exe");
fs.copyFileSync(process.execPath, bundledNode);
if (process.platform !== "win32") fs.chmodSync(bundledNode, 0o755);

// The native SQLCipher backend is optional for the VSIX (which must remain
// installable on hosts with an older embedded Node), but the standalone Tauri
// app ships a current Node runtime and can safely carry the prebuilt module.
const extensionNodeModules = extensionRoot ? path.join(extensionRoot, "node_modules") : path.join(sourceAssetRoot, "node_modules");
const optionalPackages = ["better-sqlite3-multiple-ciphers", "node-addon-api", "@a2a-js/sdk", "@modelcontextprotocol/sdk", "@ag-ui/core", "zod", "jose", "uuid"];
const copiedPackages = new Set();
for (const packageName of optionalPackages) copyPackage(packageName);
if (fs.existsSync(runtimeModules)) {
  fs.cpSync(runtimeModules, path.join(assetsDestination, "node_modules"), { recursive: true, force: true, dereference: true });
}

function copyPackage(packageName) {
  if (copiedPackages.has(packageName)) return;
  let packageSource = path.join(extensionNodeModules, packageName);
  if (!fs.existsSync(packageSource)) {
    const pnpmRoot = path.join(extensionNodeModules, ".pnpm");
    const encodedName = packageName.replace("/", "+");
    const pnpmPackage = fs.existsSync(pnpmRoot)
      ? fs.readdirSync(pnpmRoot).filter((entry) => entry.startsWith(`${encodedName}@`)).sort().at(-1)
      : undefined;
    if (pnpmPackage) packageSource = path.join(pnpmRoot, pnpmPackage, "node_modules", packageName);
  }
  if (!fs.existsSync(packageSource)) {
    console.warn(`Optional runtime package not found: ${packageName}`);
    return;
  }
  copiedPackages.add(packageName);
  // pnpm exposes workspace packages through symlinks; resolve the package
  // root before copying so the installer does not require Developer Mode.
  const realSource = fs.realpathSync(packageSource);
  fs.cpSync(realSource, path.join(runtimeModules, packageName), { recursive: true, dereference: true });
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(realSource, "package.json"), "utf8"));
    for (const dependency of Object.keys({ ...(manifest.dependencies || {}), ...(manifest.peerDependencies || {}) })) copyPackage(dependency);
  } catch { /* package metadata is not required for legacy optional modules */ }
}
console.log(`Copied broker ${require(path.join(destination, "broker-manifest.json")).brokerVersion} to ${destination}`);

function copyRequired(sourcePath, destinationPath, recursive = false) {
  if (!fs.existsSync(sourcePath)) throw new Error(`Required broker runtime asset is missing: ${sourcePath}`);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.cpSync(sourcePath, destinationPath, { recursive, force: true });
}
