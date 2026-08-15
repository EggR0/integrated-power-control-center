import * as fs from "fs";
import * as path from "path";

export interface RunItem {
  id: string;
  title: string;
  status: string;
  active: boolean;
  model?: string;
  provider?: string;
  taskScale?: string;
  elapsedSeconds?: number;
  tokensUsed?: number;
  exitCode?: number;
  timestamp?: string;
  artifacts?: Array<{ path: string; label?: string }>;
}

export interface LocalLlmMetricItem {
  timestamp: string;
  taskTitle: string;
  model: string;
  taskScale: string;
  actualElapsedSeconds: number;
  totalTokens: number;
  tokensPerSecond?: number;
  success: boolean;
  selectedBy?: string;
  selectionReason?: string;
  taskType?: string;
}

export function scanWorkspaceRuns(): { runs: RunItem[]; activeCount: number } {
  const candidateDirs = [
    process.cwd(),
    path.resolve(process.cwd(), "..", "Integrated POWER"),
    path.resolve(process.cwd(), ".."),
    "D:\\Workspace\\Integrated POWER",
  ];

  const runs: RunItem[] = [];

  for (const dir of candidateDirs) {
    const runsFile = path.join(dir, ".agent-runs", "runs.jsonl");
    if (fs.existsSync(runsFile)) {
      try {
        const content = fs.readFileSync(runsFile, "utf8");
        const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
        const map = new Map<string, RunItem>();

        lines.forEach((line, idx) => {
          try {
            const raw = JSON.parse(line);
            const id = raw.id || raw.runId || raw.run_id || `run-${idx + 1}`;
            const title = raw.title || raw.task || raw.goal || `Task ${id}`;
            const status = String(raw.status || raw.state || "unknown").toLowerCase();
            const active = status === "running" || status === "in_progress" || status === "active";
            const model = raw.model || raw.selectedModel;
            const provider = raw.provider || raw.originProvider;
            const taskScale = raw.taskScale || raw.scale;
            const elapsedSeconds = typeof raw.elapsedSeconds === "number" ? raw.elapsedSeconds : undefined;
            const tokensUsed = typeof raw.tokensUsed === "number" ? raw.tokensUsed : undefined;
            const exitCode = typeof raw.exitCode === "number" ? raw.exitCode : undefined;
            const timestamp = raw.timestamp || raw.startedAt || raw.createdAt;
            const artifacts = Array.isArray(raw.artifacts)
              ? raw.artifacts.map((a: any) => (typeof a === "string" ? { path: a } : a))
              : [];

            map.set(id, {
              id,
              title,
              status,
              active,
              model,
              provider,
              taskScale,
              elapsedSeconds,
              tokensUsed,
              exitCode,
              timestamp,
              artifacts,
            });
          } catch {
            // ignore malformed lines
          }
        });

        runs.push(...Array.from(map.values()));
      } catch {
        // ignore file read error
      }
    }
  }

  // De-duplicate by id
  const unique = Array.from(new Map(runs.map((r) => [r.id, r])).values()).reverse();
  return {
    runs: unique,
    activeCount: unique.filter((r) => r.active).length,
  };
}

export function scanLocalLlmMetrics(): LocalLlmMetricItem[] {
  const candidateDirs = [
    process.cwd(),
    path.resolve(process.cwd(), "..", "Integrated POWER"),
    path.resolve(process.cwd(), ".."),
    "D:\\Workspace\\Integrated POWER",
  ];

  for (const dir of candidateDirs) {
    const csvFile = path.join(dir, ".agent-runs", "local_llm_metrics.csv");
    if (fs.existsSync(csvFile)) {
      try {
        const text = fs.readFileSync(csvFile, "utf8");
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length > 1) {
          const headers = lines[0].split(",").map((h) => h.trim());
          return lines.slice(1).map((line) => {
            const parts = line.split(",").map((p) => p.trim());
            const val = (name: string, fallbackIdx = 0) => {
              const idx = headers.indexOf(name);
              return idx >= 0 ? parts[idx] : parts[fallbackIdx] || "";
            };
            return {
              timestamp: val("Timestamp", 0),
              taskTitle: val("TaskTitle", 1),
              model: val("Model", 2),
              taskScale: val("TaskScale", 3),
              actualElapsedSeconds: parseFloat(val("ActualElapsedSeconds", 4) || "0"),
              totalTokens: parseInt(val("TotalTokens", 5) || "0", 10),
              tokensPerSecond: parseFloat(val("TokensPerSecond") || "0") || undefined,
              success: val("Success").toLowerCase() === "true",
              selectedBy: val("SelectedBy"),
              selectionReason: val("SelectionReason"),
              taskType: val("TaskType"),
            };
          });
        }
      } catch {
        // ignore
      }
    }
  }
  return [];
}
