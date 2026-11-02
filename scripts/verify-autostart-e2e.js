// Real registry round-trip for the autostart fix (Windows). Enables, reads
// back, asserts the resolved target, then DISABLES to leave the system clean.
const path = require("path");
const fs = require("fs");
const { getExtensionRoot } = require("./workspace-paths.js");

let autostart;
try {
  const extensionRoot = getExtensionRoot();
  autostart = require(path.join(extensionRoot, "out", "broker", "autostart.js"));
} catch {
  const bundled = path.resolve(__dirname, "..", "src-tauri", "resources", "broker-out", "broker", "autostart.js");
  if (fs.existsSync(bundled)) autostart = require(bundled);
  else throw new Error("Could not locate compiled autostart module.");
}

const { getAutoStartStatus, setAutoStart, resolveAutoStartTarget } = autostart;

(async () => {
  const before = await getAutoStartStatus();
  console.log("BEFORE:", JSON.stringify(before));

  const target = resolveAutoStartTarget();
  console.log("RESOLVED TARGET:", target);

  // The fix: on this dev machine the release exe exists, so the target must be
  // a quoted .exe path — NOT bare "node". This is exactly the bug we fixed.
  const isBareNode = target.replace(/"/g, "") === "node" || /^"node"$/i.test(target) || target.trim() === "node";
  const pointsToExe = /\.exe["]?$/.test(target);
  console.log("pointsToRealExe:", pointsToExe, "| isBareNode:", isBareNode);

  const enabled = await setAutoStart(true);
  console.log("ENABLED:", JSON.stringify(enabled));

  const after = await getAutoStartStatus();
  console.log("AFTER-ENABLE:", JSON.stringify(after));
  const readbackMatches = after.enabled && after.targetPath && after.targetPath === target;
  console.log("READBACK_MATCHES:", readbackMatches);

  const disabled = await setAutoStart(false);
  const final = await getAutoStartStatus();
  console.log("AFTER-DISABLE:", JSON.stringify(final));
  console.log("CLEANUP_OK:", !final.enabled);

  const pass = pointsToExe && !isBareNode && readbackMatches && !final.enabled;
  console.log(pass ? "=== REGISTRY E2E PASS ===" : "=== REGISTRY E2E FAIL ===");
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error("E2E error:", e); process.exit(2); });
