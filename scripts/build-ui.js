const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getSharedQuotaSource } = require("./shared-quota-source.js");

const quotaSource = getSharedQuotaSource();
const result = spawnSync(process.execPath, [path.join(__dirname, "..", "node_modules", "vite", "bin", "vite.js"), "build"], {
  cwd: path.resolve(__dirname, ".."),
  stdio: "inherit",
  env: { ...process.env, INTEGRATED_POWER_SHARED_QUOTA_SOURCE: quotaSource },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
