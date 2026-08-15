import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as http from "http";

export interface GpuStatus {
  id: number;
  name: string;
  utilizationPercentage: number;
  vramUsedMb: number;
  vramTotalMb: number;
  powerDrawW?: number;
  powerLimitW?: number;
}

export interface LiveTokenStatus {
  antigravityPercentage?: number;
  antigravityResetTime?: string;
  antigravityWeeklyPercentage?: number;
  antigravityWeeklyResetTime?: string;

  opusPercentage?: number;
  opusResetTime?: string;
  opusWeeklyPercentage?: number;
  opusWeeklyResetTime?: string;

  codexPercentage?: number;
  codexResetTime?: string;
  codexWeeklyPercentage?: number;
  codexWeeklyResetTime?: string;

  taskRouting: "normal" | "degraded" | "critical";
  lastSync: string;
  localComputeStatus: {
    status: "online" | "offline" | "busy";
    modelName: string;
    vramUsedMb: number;
    vramTotalMb: number;
    gpus: GpuStatus[];
  };
  directUsage?: {
    todayTokens: number;
    todayPaidTokens: number;
    todayThinkingTokens: number;
    sevenDaysTokens: number;
    sevenDaysPaidTokens: number;
    eventCount: number;
  };
  activity?: string[];
}

export async function scanGpuMetrics(): Promise<GpuStatus[]> {
  return new Promise((resolve) => {
    cp.execFile(
      "nvidia-smi",
      [
        "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,power.draw,power.limit,enforced.power.limit",
        "--format=csv,noheader,nounits",
      ],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error || !stdout) {
          return resolve([]);
        }
        const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const gpus: GpuStatus[] = [];
        for (const line of lines) {
          const parts = line.split(",").map((p) => p.trim());
          if (parts.length >= 5) {
            const id = parseInt(parts[0], 10) || 0;
            const name = parts[1] || `GPU ${id}`;
            const utilizationPercentage = parseFloat(parts[2]) || 0;
            const vramUsedMb = parseFloat(parts[3]) || 0;
            const vramTotalMb = parseFloat(parts[4]) || 0;
            const powerDrawW = parts[5] ? parseFloat(parts[5]) : undefined;
            const powerLimit = parts[6] ? parseFloat(parts[6]) : undefined;
            const enforcedLimit = parts[7] ? parseFloat(parts[7]) : undefined;
            const powerLimitW = Number.isFinite(powerLimit) && (powerLimit || 0) > 0 ? powerLimit : enforcedLimit;

            gpus.push({
              id,
              name,
              utilizationPercentage,
              vramUsedMb,
              vramTotalMb,
              powerDrawW,
              powerLimitW,
            });
          }
        }
        resolve(gpus);
      },
    );
  });
}

export async function scanCodexQuota(): Promise<{
  codexPercentage?: number;
  codexResetTime?: string;
  codexWeeklyPercentage?: number;
  codexWeeklyResetTime?: string;
}> {
  try {
    const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
    if (!fs.existsSync(sessionsDir)) return {};

    const files = fs.readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((name) => {
        const fullPath = path.join(sessionsDir, name);
        return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 10);

    for (const file of files) {
      const content = fs.readFileSync(file.fullPath, "utf8");
      const lines = content.split(/\r?\n/).reverse().slice(0, 50);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "event_msg" && event.payload?.type === "token_count" && event.payload?.rate_limits) {
            const limits = event.payload.rate_limits;
            const primary = limits.primary;
            const secondary = limits.secondary;

            let codexPercentage: number | undefined;
            let codexResetTime: string | undefined;
            let codexWeeklyPercentage: number | undefined;
            let codexWeeklyResetTime: string | undefined;

            const parseLimit = (l: any) => {
              if (!l) return undefined;
              const usedPercent = typeof l.used_percent === "number" ? l.used_percent : undefined;
              const resetsAt = typeof l.resets_at === "number" ? l.resets_at : undefined;
              const isReset = resetsAt && resetsAt * 1000 < Date.now();
              const pct = usedPercent !== undefined ? (isReset ? 100 : Math.max(0, Math.min(100, 100 - usedPercent))) : undefined;
              const reset = resetsAt ? new Date(resetsAt * 1000).toISOString() : undefined;
              return { pct, reset };
            };

            const pInfo = parseLimit(primary);
            const sInfo = parseLimit(secondary);

            if (primary?.window_minutes && primary.window_minutes <= 1440) {
              codexPercentage = pInfo?.pct;
              codexResetTime = pInfo?.reset;
            } else if (pInfo) {
              codexWeeklyPercentage = pInfo.pct;
              codexWeeklyResetTime = pInfo.reset;
            }

            if (secondary?.window_minutes && secondary.window_minutes > 1440) {
              codexWeeklyPercentage = sInfo?.pct;
              codexWeeklyResetTime = sInfo?.reset;
            } else if (secondary && !codexPercentage && sInfo) {
              codexPercentage = sInfo.pct;
              codexResetTime = sInfo.reset;
            }

            return {
              codexPercentage,
              codexResetTime,
              codexWeeklyPercentage,
              codexWeeklyResetTime,
            };
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  return {};
}

function probeOllama(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: 11434, path: "/api/tags", timeout: 800 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function findTokenStatusJsonPath(): string | undefined {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    path.join(localAppData, "IntegratedPower", "state", "token_status.json"),
    path.join(os.homedir(), ".config", "integrated-power", "state", "token_status.json"),
    path.join(localAppData, "EggR", "state", "token_status.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

export async function scanLiveTokenStatus(): Promise<LiveTokenStatus> {
  // 1. Primary source of truth: Live token_status.json written by IDE TokenManager
  const statePath = findTokenStatusJsonPath();
  if (statePath) {
    try {
      const raw = fs.readFileSync(statePath, "utf8");
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        let antigravityPercentage: number | undefined;
        let antigravityResetTime: string | undefined;
        let antigravityWeeklyPercentage: number | undefined;
        let antigravityWeeklyResetTime: string | undefined;

        let opusPercentage: number | undefined;
        let opusResetTime: string | undefined;
        let opusWeeklyPercentage: number | undefined;
        let opusWeeklyResetTime: string | undefined;

        let codexPercentage: number | undefined;
        let codexResetTime: string | undefined;
        let codexWeeklyPercentage: number | undefined;
        let codexWeeklyResetTime: string | undefined;

        if (Array.isArray(data.quotaPools)) {
          for (const pool of data.quotaPools) {
            if (pool.id === "antigravity.default" || (pool.provider === "antigravity" && !pool.id?.includes("weekly"))) {
              antigravityPercentage = pool.remainingPercentage;
              antigravityResetTime = pool.resetTime;
            } else if (pool.id === "antigravity.weekly" || (pool.provider === "antigravity" && pool.id?.includes("weekly"))) {
              antigravityWeeklyPercentage = pool.remainingPercentage;
              antigravityWeeklyResetTime = pool.resetTime;
            } else if (pool.id === "opus.default" || (pool.provider === "anthropic" && !pool.id?.includes("weekly"))) {
              opusPercentage = pool.remainingPercentage;
              opusResetTime = pool.resetTime;
            } else if (pool.id === "opus.weekly" || (pool.provider === "anthropic" && pool.id?.includes("weekly"))) {
              opusWeeklyPercentage = pool.remainingPercentage;
              opusWeeklyResetTime = pool.resetTime;
            } else if (pool.id === "codex.5h" || (pool.provider === "codex" && !pool.id?.includes("weekly"))) {
              codexPercentage = pool.remainingPercentage;
              codexResetTime = pool.resetTime;
            } else if (pool.id === "codex.weekly" || (pool.provider === "codex" && pool.id?.includes("weekly"))) {
              codexWeeklyPercentage = pool.remainingPercentage;
              codexWeeklyResetTime = pool.resetTime;
            }
          }
        }

        // Direct usage
        const cdu = data.claudeDirectUsage;
        const directUsage = {
          todayTokens: cdu?.today?.totalTokens ?? 0,
          todayPaidTokens: cdu?.today?.billableTokens ?? 0,
          todayThinkingTokens: cdu?.today?.reasoningOutputTokens ?? 0,
          sevenDaysTokens: cdu?.sevenDays?.totalTokens ?? 0,
          sevenDaysPaidTokens: cdu?.sevenDays?.billableTokens ?? 0,
          eventCount: cdu?.today?.eventCount ?? cdu?.sevenDays?.eventCount ?? 0,
        };

        // GPUs
        const gpus: GpuStatus[] = Array.isArray(data.localComputeStatus?.gpus)
          ? data.localComputeStatus.gpus
          : await scanGpuMetrics();
        const vramUsedMb = gpus.reduce((acc, g) => acc + (g.vramUsedMb || 0), 0);
        const vramTotalMb = gpus.reduce((acc, g) => acc + (g.vramTotalMb || 0), 0);

        // Ollama status
        const isOnline = data.localComputeStatus?.endpointHealth === "ok" || (await probeOllama());
        const isBusy = gpus.some((g) => g.utilizationPercentage > 20);

        let taskRouting: "normal" | "degraded" | "critical" = "normal";
        if (data.recommendedTaskWeight === "degraded" || data.recommendedTaskWeight === "restricted") {
          taskRouting = "degraded";
        } else if ((codexWeeklyPercentage !== undefined && codexWeeklyPercentage < 20) || (antigravityPercentage !== undefined && antigravityPercentage < 20)) {
          taskRouting = "degraded";
        }

        return {
          antigravityPercentage,
          antigravityResetTime,
          antigravityWeeklyPercentage,
          antigravityWeeklyResetTime,
          opusPercentage,
          opusResetTime,
          opusWeeklyPercentage,
          opusWeeklyResetTime,
          codexPercentage,
          codexResetTime,
          codexWeeklyPercentage,
          codexWeeklyResetTime,
          taskRouting,
          lastSync: new Date().toISOString(),
          localComputeStatus: {
            status: isOnline ? (isBusy ? "busy" : "online") : "offline",
            modelName: data.localComputeStatus?.loadedModels?.[0] || "qwen3.6:27b",
            vramUsedMb,
            vramTotalMb,
            gpus,
          },
          directUsage,
          activity: Array.isArray(data.activity) ? data.activity : undefined,
        };
      }
    } catch {
      // Fall through to live scanning if file read fails
    }
  }

  // 2. Fallback: Standalone live scanning when IDE state is not present
  const gpus = await scanGpuMetrics();
  const vramUsedMb = gpus.reduce((acc, g) => acc + (g.vramUsedMb || 0), 0);
  const vramTotalMb = gpus.reduce((acc, g) => acc + (g.vramTotalMb || 0), 0);
  const codex = await scanCodexQuota();
  const isOnline = await probeOllama();
  const isBusy = gpus.some((g) => g.utilizationPercentage > 20);

  return {
    antigravityPercentage: undefined,
    antigravityResetTime: undefined,
    antigravityWeeklyPercentage: undefined,
    antigravityWeeklyResetTime: undefined,
    opusPercentage: undefined,
    opusResetTime: undefined,
    opusWeeklyPercentage: undefined,
    opusWeeklyResetTime: undefined,
    codexPercentage: codex.codexPercentage,
    codexResetTime: codex.codexResetTime,
    codexWeeklyPercentage: codex.codexWeeklyPercentage,
    codexWeeklyResetTime: codex.codexWeeklyResetTime,
    taskRouting: (codex.codexWeeklyPercentage !== undefined && codex.codexWeeklyPercentage < 20) ? "degraded" : "normal",
    lastSync: new Date().toISOString(),
    localComputeStatus: {
      status: isOnline ? (isBusy ? "busy" : "online") : "offline",
      modelName: "qwen3.6:27b",
      vramUsedMb,
      vramTotalMb,
      gpus,
    },
    directUsage: {
      todayTokens: 0,
      todayPaidTokens: 0,
      todayThinkingTokens: 0,
      sevenDaysTokens: 0,
      sevenDaysPaidTokens: 0,
      eventCount: 0,
    },
    activity: [
      "Broker token scanner active.",
      `Live scan at ${new Date().toLocaleTimeString()}`,
    ],
  };
}
