import { defineConfig } from "vite";
import path from "node:path";

const sharedQuotaSource = process.env.INTEGRATED_POWER_SHARED_QUOTA_SOURCE;
if (!sharedQuotaSource) throw new Error("INTEGRATED_POWER_SHARED_QUOTA_SOURCE must identify the shared quota source.");

const sharedHubSource = process.env.INTEGRATED_POWER_SHARED_HUB_SOURCE;
if (!sharedHubSource) throw new Error("INTEGRATED_POWER_SHARED_HUB_SOURCE must identify the shared hub source.");

export default defineConfig({
  resolve: {
    alias: {
      "@shared/quota": path.resolve(sharedQuotaSource),
      "@shared/hub": path.resolve(sharedHubSource),
    },
  },
});
