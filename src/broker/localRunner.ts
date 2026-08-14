import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { TaskEnvelope } from "./protocol";

const execFileAsync = promisify(execFile);
const DEFAULT_MODEL = "qwen3.6:27b";

export interface LocalRunResult {
  text: string;
  model: string;
  selection: Record<string, any>;
  outputFile: string;
}

export function legacyLocalRunnerAvailable(): boolean {
  if (process.platform !== "win32") return false;
  const root = resolveScriptsRoot();
  return fs.existsSync(path.join(root, "Select-LocalLLMModel.ps1")) && fs.existsSync(path.join(root, "Invoke-LocalLLM.ps1"));
}

/** Thin Node boundary around the existing, tested PowerShell selector/runner.
 * The broker deliberately does not implement model ranking or call Ollama's
 * generate endpoint itself. */
export async function runLegacyLocalLlm(task: TaskEnvelope, prompt: string, requestedEndpoint?: string): Promise<LocalRunResult> {
  if (process.platform !== "win32") {
    throw new Error("The legacy local runner is currently available on Windows; use the planned platform adapter after shared-policy extraction.");
  }
  const scriptsRoot = resolveScriptsRoot();
  const selector = path.join(scriptsRoot, "Select-LocalLLMModel.ps1");
  const runner = path.join(scriptsRoot, "Invoke-LocalLLM.ps1");
  if (!fs.existsSync(selector) || !fs.existsSync(runner)) throw new Error(`Legacy local runner scripts are missing under ${scriptsRoot}.`);

  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "integrated-power-local-"));
  const outputFile = path.join(tempRoot, `${task.id}.md`);
  const preferred = process.env.INTEGRATED_POWER_LOCAL_MODEL || DEFAULT_MODEL;
  const endpoint = requestedEndpoint || process.env.INTEGRATED_POWER_LOCAL_ENDPOINT || normalizeHost(process.env.OLLAMA_HOST) || (fs.existsSync("D:\\AI_Models") ? "http://127.0.0.1:11435" : "http://127.0.0.1:11434");
  const selection = await invokePowerShellJson(selector, [
    "-TaskType", "coding",
    "-TaskScale", "Large",
    "-InstalledOnly",
    "-PreferredModel", preferred,
    "-HardwareMode", "user_default",
    "-OllamaEndpoint", endpoint,
    "-AsJson",
  ], task.workspacePath);
  const model = String(selection.SelectedModel || "").trim();
  if (!model) throw new Error(String(selection.AgentPrompt || "The legacy selector returned no installed model."));

  const contextFiles = task.contextFiles ?? [];
  const args = [
    "-PromptText", `${prompt}\n\nTask id: ${task.id}. Do not access files outside the assigned workspace.`,
    "-OutputFile", outputFile,
    "-TaskKey", task.id,
    "-ArtifactPolicy", "Coalesce",
    "-TaskTitle", task.title,
    "-TaskType", "coding",
    "-TaskScale", "Large",
    "-Model", model,
    "-SelectedBy", String(selection.SelectionBasis || "legacy-selector"),
    "-SelectionReason", String(selection.Reason || "legacy selector"),
    "-SystemPrompt", process.env.INTEGRATED_POWER_LOCAL_SYSTEM_PROMPT
      || "You are a focused coding worker. Follow the user's requested output format exactly. Do not return a review or ask a question. Return only the requested final artifact or concise completion summary.",
    "-KeepAlive", "30m",
    "-ColdLoadTimeoutSeconds", "1800",
    "-TimeoutSeconds", "900",
  ];
  for (const file of contextFiles) args.push("-ContextFile", file);
  await invokePowerShell(runner, args, task.workspacePath, { OLLAMA_HOST: endpoint });
  const text = await fs.promises.readFile(outputFile, "utf8").catch(() => "");
  if (!text.trim()) throw new Error("The legacy local runner completed without an artifact.");
  return { text, model, selection, outputFile };
}

function resolveScriptsRoot(): string {
  const candidates: string[] = [];
  const configured = process.env.INTEGRATED_POWER_LOCAL_SCRIPTS?.trim();
  if (configured) candidates.push(path.resolve(configured));

  candidates.push(path.resolve(__dirname, "../../assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts"));
  candidates.push(path.resolve(__dirname, "../assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts"));
  candidates.push(path.resolve(__dirname, "../../vscode-extension/assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts"));
  candidates.push(path.resolve(__dirname, "../../../vscode-extension/assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts"));
  candidates.push(path.resolve(process.cwd(), "vscode-extension/assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts"));
  candidates.push(path.resolve(process.cwd(), "assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts"));

  const home = os.homedir();
  candidates.push(path.join(home, ".gemini", "config", "plugins", "ip-orchestrator-plugin", "skills", "ip-orchestrator", "scripts"));
  candidates.push(path.join(home, ".gemini", "antigravity-ide", "plugins", "ip-orchestrator-plugin", "skills", "ip-orchestrator", "scripts"));
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push(path.join(localAppData, "IntegratedPower", "plugins", "ip-orchestrator-plugin", "skills", "ip-orchestrator", "scripts"));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "Select-LocalLLMModel.ps1")) && fs.existsSync(path.join(candidate, "Invoke-LocalLLM.ps1"))) {
      return candidate;
    }
  }
  return candidates[0] || path.resolve(__dirname, "../../assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts");
}

function normalizeHost(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const candidate = value.includes("://") ? value : `http://${value}`;
  if (/^https?:\/\/0\.0\.0\.0(?::\d+)?$/i.test(candidate)) return candidate.replace("0.0.0.0", "127.0.0.1");
  return /:\d+$/i.test(candidate) ? candidate : `${candidate}:11434`;
}

async function invokePowerShellJson(file: string, args: string[], cwd?: string): Promise<Record<string, any>> {
  const result = await invokePowerShell(file, args, cwd);
  try { return JSON.parse(result.stdout.trim()) as Record<string, any>; }
  catch { throw new Error(`Legacy selector returned invalid JSON: ${result.stdout.slice(-500)}`); }
}

async function invokePowerShell(file: string, args: string[], cwd?: string, extraEnv?: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, ...args], {
    cwd: cwd && fs.existsSync(cwd) ? cwd : process.cwd(),
    windowsHide: true,
    timeout: 35 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...extraEnv, INTEGRATED_POWER_LOCAL_MODEL: process.env.INTEGRATED_POWER_LOCAL_MODEL || DEFAULT_MODEL },
  });
}
