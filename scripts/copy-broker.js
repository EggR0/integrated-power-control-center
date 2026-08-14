const fs = require("fs");
const path = require("path");

const localSource = path.resolve(__dirname, "..", "broker-out", "broker");
const fallbackSource = path.resolve(__dirname, "..", "..", "Integrated POWER", "vscode-extension", "out", "broker");
const source = fs.existsSync(localSource) ? localSource : fallbackSource;
const destination = path.resolve(__dirname, "..", "src-tauri", "resources", "broker-out", "broker");
const resourceRoot = path.resolve(__dirname, "..", "src-tauri", "resources");
const runtimeModules = path.join(resourceRoot, "node_modules");
if (!fs.existsSync(source)) throw new Error(`Compiled broker not found: ${source}`);
fs.rmSync(destination, { recursive: true, force: true });
fs.rmSync(runtimeModules, { recursive: true, force: true });
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.cpSync(source, destination, { recursive: true });
fs.copyFileSync(path.resolve(__dirname, "..", "broker-server.js"), path.join(resourceRoot, "broker-server.js"));
fs.copyFileSync(path.resolve(__dirname, "..", "mcp-server.js"), path.join(resourceRoot, "mcp-server.js"));
// Keep a stable executable filename. Windows CreateProcess requires an
// executable extension; Unix treats the .exe suffix as an ordinary filename.
fs.rmSync(path.join(resourceRoot, "node-runtime"), { force: true });
const bundledNode = path.join(resourceRoot, "node-runtime.exe");
fs.copyFileSync(process.execPath, bundledNode);
if (process.platform !== "win32") fs.chmodSync(bundledNode, 0o755);

// The native SQLCipher backend is optional for the VSIX (which must remain
// installable on hosts with an older embedded Node), but the standalone Tauri
// app ships a current Node runtime and can safely carry the prebuilt module.
const localNodeModules = path.resolve(__dirname, "..", "node_modules");
const fallbackNodeModules = path.resolve(__dirname, "..", "..", "Integrated POWER", "vscode-extension", "node_modules");
const extensionNodeModules = fs.existsSync(localNodeModules) ? localNodeModules : fallbackNodeModules;
const optionalPackages = ["better-sqlite3-multiple-ciphers", "node-addon-api", "@a2a-js/sdk", "@modelcontextprotocol/sdk", "@ag-ui/core", "zod", "jose", "uuid"];
const copiedPackages = new Set();
for (const packageName of optionalPackages) copyPackage(packageName);

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
  fs.cpSync(realSource, path.join(runtimeModules, packageName), { recursive: true });
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(realSource, "package.json"), "utf8"));
    for (const dependency of Object.keys({ ...(manifest.dependencies || {}), ...(manifest.peerDependencies || {}) })) copyPackage(dependency);
  } catch { /* package metadata is not required for legacy optional modules */ }
}
console.log(`Copied broker runtime to ${destination}`);
