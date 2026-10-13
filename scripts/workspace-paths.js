const path = require("node:path");

function getExtensionRoot() {
  const explicit = process.env.INTEGRATED_POWER_EXTENSION_ROOT?.trim();
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!require("node:fs").existsSync(path.join(resolved, "package.json"))) {
      throw new Error(`INTEGRATED_POWER_EXTENSION_ROOT is not a VSIX project directory: ${resolved}`);
    }
    return resolved;
  }
  const candidates = [
    path.resolve(__dirname, "..", "..", "vscode-extension"),
    path.resolve(__dirname, "..", "..", "Integrated POWER", "vscode-extension"),
  ];
  const result = candidates.find((candidate) => require("node:fs").existsSync(path.join(candidate, "package.json")));
  if (!result) throw new Error("Set INTEGRATED_POWER_EXTENSION_ROOT to the VSIX project directory.");
  return result;
}

module.exports = { getExtensionRoot };
