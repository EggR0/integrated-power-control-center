const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const resourceRoot = path.join(root, "src-tauri", "resources");
const bundleRoot = path.join(root, "src-tauri", "target", "release", "bundle");
for (const required of [
  path.join(resourceRoot, "broker-server.js"),
  path.join(resourceRoot, "mcp-server.js"),
  path.join(resourceRoot, "node-runtime.exe"),
  path.join(resourceRoot, "broker-out", "broker", "index.js"),
]) {
  if (!fs.existsSync(required)) throw new Error(`Missing bundled runtime file: ${required}`);
}

const files = listFiles(bundleRoot);
if (!files.length) throw new Error(`No Tauri bundle artifacts found under ${bundleRoot}`);
const platform = process.platform;
const expected = platform === "win32" ? /\.(msi|exe)$/i : platform === "darwin" ? /\.(dmg|app\.tar\.gz)$/i : /\.(AppImage|deb|rpm)$/i;
if (!files.some((file) => expected.test(file))) throw new Error(`No expected ${platform} installer artifact found. Found: ${files.join(", ")}`);
const runtime = path.join(resourceRoot, "node-runtime.exe");
if (platform !== "win32" && (fs.statSync(runtime).mode & 0o111) === 0) throw new Error("Bundled Node runtime is not executable on Unix.");
console.log(JSON.stringify({ platform, artifacts: files.filter((file) => expected.test(file)), runtime: "ok" }));

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(full));
    else result.push(full);
  }
  return result;
}
