const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getSharedQuotaSource } = require("./shared-quota-source.js");
const { getSharedHubSource } = require("./shared-hub-source.js");

const quotaSource = getSharedQuotaSource();
const hubSource = getSharedHubSource();
const result = spawnSync(process.execPath, [path.join(__dirname, "..", "node_modules", "vite", "bin", "vite.js"), "build"], {
  cwd: path.resolve(__dirname, ".."),
  stdio: "inherit",
  env: {
    ...process.env,
    INTEGRATED_POWER_SHARED_QUOTA_SOURCE: quotaSource,
    INTEGRATED_POWER_SHARED_HUB_SOURCE: hubSource,
  },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
