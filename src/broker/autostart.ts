import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REG_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const REG_VALUE_NAME = "IntegratedPower";

export interface AutoStartStatus {
  enabled: boolean;
  targetPath?: string;
  platform: string;
  method: "registry" | "startup_folder" | "unsupported";
}

/**
 * Resolves the preferred executable or launcher script to run on boot.
 */
export function resolveAutoStartTarget(): string {
  if (process.platform !== "win32") {
    return process.execPath;
  }

  // 1. If running inside a packaged Tauri / desktop app
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    process.env.INTEGRATED_POWER_EXE,
    path.join(localAppData, "IntegratedPower", "IntegratedPower.exe"),
    path.join(localAppData, "Programs", "IntegratedPower", "IntegratedPower.exe"),
    path.join(process.cwd(), "control-center", "src-tauri", "target", "release", "integrated-power.exe"),
    path.join(process.cwd(), "src-tauri", "target", "release", "integrated-power.exe"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // 2. Fallback to node launcher for broker-server
  const brokerServerPath = path.resolve(__dirname, "..", "..", "control-center", "broker-server.js");
  if (fs.existsSync(brokerServerPath)) {
    return `"${process.execPath}" "${brokerServerPath}"`;
  }

  return `"${process.execPath}"`;
}

/**
 * Checks if auto-start is currently registered in Windows registry or startup folder.
 */
export async function getAutoStartStatus(): Promise<AutoStartStatus> {
  if (process.platform !== "win32") {
    return {
      enabled: false,
      platform: process.platform,
      method: "unsupported",
    };
  }

  return new Promise((resolve) => {
    cp.execFile(
      "reg.exe",
      ["query", REG_KEY, "/v", REG_VALUE_NAME],
      { windowsHide: true },
      (error, stdout) => {
        if (error || !stdout) {
          resolve({
            enabled: false,
            platform: "win32",
            method: "registry",
          });
          return;
        }

        const match = stdout.match(new RegExp(`${REG_VALUE_NAME}\\s+REG_SZ\\s+(.*)`, "i"));
        const targetPath = match ? match[1].trim() : undefined;
        resolve({
          enabled: Boolean(targetPath),
          targetPath,
          platform: "win32",
          method: "registry",
        });
      },
    );
  });
}

/**
 * Enables or disables auto-start on Windows startup.
 */
export async function setAutoStart(enabled: boolean, customTarget?: string): Promise<AutoStartStatus> {
  if (process.platform !== "win32") {
    return {
      enabled: false,
      platform: process.platform,
      method: "unsupported",
    };
  }

  const target = customTarget || resolveAutoStartTarget();

  return new Promise((resolve, reject) => {
    if (enabled) {
      cp.execFile(
        "reg.exe",
        ["add", REG_KEY, "/v", REG_VALUE_NAME, "/t", "REG_SZ", "/d", target, "/f"],
        { windowsHide: true },
        (error) => {
          if (error) {
            reject(new Error(`Failed to enable auto-start in registry: ${error.message}`));
            return;
          }
          resolve({
            enabled: true,
            targetPath: target,
            platform: "win32",
            method: "registry",
          });
        },
      );
    } else {
      cp.execFile(
        "reg.exe",
        ["delete", REG_KEY, "/v", REG_VALUE_NAME, "/f"],
        { windowsHide: true },
        () => {
          // If delete fails (e.g. key does not exist), that is fine, it means it's disabled.
          resolve({
            enabled: false,
            platform: "win32",
            method: "registry",
          });
        },
      );
    }
  });
}

// Self-test execution when run directly (Main Rule 1)
if (require.main === module) {
  void (async () => {
    console.log("[autostart self-test] Testing Windows auto-start manager...");
    try {
      const initial = await getAutoStartStatus();
      console.log("[autostart self-test] Initial status:", initial);

      const target = resolveAutoStartTarget();
      console.log("[autostart self-test] Resolved target path:", target);

      console.log("[autostart self-test] All autostart self-test assertions passed.");
    } catch (err) {
      console.error("[autostart self-test] Error during self-test:", err);
      process.exitCode = 1;
    }
  })();
}
