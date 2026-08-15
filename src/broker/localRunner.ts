import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import * as https from "https";
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

/** Check if a local LLM runner is available. Supported natively on all OS platforms (macOS, Linux, Windows). */
export function legacyLocalRunnerAvailable(): boolean {
  return true;
}

/** Cross-platform Local LLM Runner (macOS, Linux, Windows).
 * Runs natively via Node.js HTTP with fallback to Windows PowerShell scripts if present. */
export async function runLegacyLocalLlm(task: TaskEnvelope, prompt: string, requestedEndpoint?: string): Promise<LocalRunResult> {
  const preferred = process.env.INTEGRATED_POWER_LOCAL_MODEL || DEFAULT_MODEL;
  const endpoint = requestedEndpoint || process.env.INTEGRATED_POWER_LOCAL_ENDPOINT || normalizeHost(process.env.OLLAMA_HOST) || "http://127.0.0.1:11434";

  // If on Windows and PowerShell scripts are present, attempt PowerShell run first
  if (process.platform === "win32") {
    const scriptsRoot = resolveScriptsRoot();
    const selector = path.join(scriptsRoot, "Select-LocalLLMModel.ps1");
    const runner = path.join(scriptsRoot, "Invoke-LocalLLM.ps1");
    if (fs.existsSync(selector) && fs.existsSync(runner)) {
      try {
        return await runWithPowerShell(task, prompt, endpoint, preferred, selector, runner);
      } catch (err: any) {
        console.warn(`[LocalRunner] PowerShell execution failed (${err.message}); falling back to native cross-platform engine.`);
      }
    }
  }

  // Cross-Platform Native Node.js Runner (macOS, Linux, Windows)
  return await runNativeCrossPlatform(task, prompt, endpoint, preferred);
}

/** Native Cross-Platform execution using direct HTTP calls to Ollama / Local LLM APIs. */
async function runNativeCrossPlatform(task: TaskEnvelope, prompt: string, endpoint: string, preferred: string): Promise<LocalRunResult> {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "integrated-power-local-"));
  const outputFile = path.join(tempRoot, `${task.id}.md`);

  // 1. Discover available models from endpoint
  const availableModels = await fetchOllamaModels(endpoint);
  if (availableModels.length === 0) {
    throw new Error(`No local LLM models found at ${endpoint}. Please ensure Ollama or your local LLM server is running.`);
  }

  // 2. Select best matching model
  const selectedModel = selectBestModel(availableModels, preferred);
  const selection = {
    SelectedModel: selectedModel,
    SelectionBasis: "cross-platform-native-selector",
    Reason: `Auto-selected ${selectedModel} from ${availableModels.length} installed models on ${os.platform()} (${os.arch()}).`,
    Endpoint: endpoint,
    Platform: process.platform,
    ContextLength: 32768,
  };

  // 3. Assemble prompt and context files
  let fullPrompt = `${prompt}\n\nTask id: ${task.id}. Do not access files outside the assigned workspace.`;
  if (task.contextFiles && task.contextFiles.length > 0) {
    for (const filePath of task.contextFiles) {
      try {
        if (fs.existsSync(filePath)) {
          const content = await fs.promises.readFile(filePath, "utf8");
          fullPrompt += `\n\n--- Context File: ${path.basename(filePath)} ---\n${content}\n--- End Context File ---`;
        }
      } catch {
        // Continue if a context file cannot be read
      }
    }
  }

  const systemPrompt = process.env.INTEGRATED_POWER_LOCAL_SYSTEM_PROMPT
    || "You are a focused coding worker. Follow the user's requested output format exactly. Do not return a review or ask a question. Return only the requested final artifact or concise completion summary.";

  // 4. Generate completion via native HTTP call
  const requestBody = {
    model: selectedModel,
    prompt: fullPrompt,
    system: systemPrompt,
    stream: false,
    options: {
      num_ctx: 32768,
    },
    keep_alive: "30m",
  };

  const response = await postJson(`${endpoint}/api/generate`, requestBody);
  const text = (response?.response || response?.content || "").trim();
  if (!text) {
    throw new Error(`The local LLM (${selectedModel}) returned an empty response.`);
  }

  // 5. Write output artifact
  await fs.promises.writeFile(outputFile, text, "utf8");
  return { text, model: selectedModel, selection, outputFile };
}

/** Windows PowerShell execution path for legacy environments. */
async function runWithPowerShell(
  task: TaskEnvelope,
  prompt: string,
  endpoint: string,
  preferred: string,
  selector: string,
  runner: string
): Promise<LocalRunResult> {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "integrated-power-local-"));
  const outputFile = path.join(tempRoot, `${task.id}.md`);
  let selection: Record<string, any>;
  try {
    selection = await invokePowerShellJson(selector, [
      "-TaskType", "coding",
      "-TaskScale", "Large",
      "-InstalledOnly",
      "-PreferredModel", preferred,
      "-HardwareMode", "user_default",
      "-OllamaEndpoint", endpoint,
      "-AsJson",
    ], task.workspacePath);
  } catch {
    selection = await invokePowerShellJson(selector, [
      "-TaskType", "coding",
      "-TaskScale", "Large",
      "-InstalledOnly",
      "-HardwareMode", "auto",
      "-OllamaEndpoint", endpoint,
      "-AsJson",
    ], task.workspacePath);
  }
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
    "-NumCtx", "32768",
  ];
  for (const file of contextFiles) args.push("-ContextFile", file);
  await invokePowerShell(runner, args, task.workspacePath, { OLLAMA_HOST: endpoint });
  const text = await fs.promises.readFile(outputFile, "utf8").catch(() => "");
  if (!text.trim()) throw new Error("The legacy local runner completed without an artifact.");
  return { text, model, selection, outputFile };
}

async function fetchOllamaModels(endpoint: string): Promise<string[]> {
  try {
    const data = await getJson(`${endpoint}/api/tags`);
    if (Array.isArray(data?.models)) {
      return data.models.map((m: any) => String(m.name || m.model || "")).filter(Boolean);
    }
  } catch (err: any) {
    console.warn(`[LocalRunner] Failed to query ${endpoint}/api/tags: ${err.message}`);
  }
  return [];
}

function selectBestModel(available: string[], preferred: string): string {
  if (available.includes(preferred)) return preferred;
  const match = available.find((m) => m.toLowerCase().includes(preferred.toLowerCase()));
  if (match) return match;
  const codingCandidates = ["qwen", "codellama", "deepseek", "starcoder", "llama"];
  for (const cand of codingCandidates) {
    const found = available.find((m) => m.toLowerCase().includes(cand));
    if (found) return found;
  }
  return available[0];
}

function getJson(urlStr: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.get(urlStr, { timeout: 5000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error(`Failed to parse JSON response from ${urlStr}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`HTTP GET timeout connecting to ${urlStr}`));
    });
  });
}

function postJson(urlStr: string, payload: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const client = parsed.protocol === "https:" ? https : http;
    const data = Buffer.from(JSON.stringify(payload), "utf8");
    const req = client.request(urlStr, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": data.length,
      },
      timeout: 30 * 60 * 1000,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error(`Failed to parse JSON response from ${urlStr}: ${body.slice(0, 300)}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`HTTP POST timeout from ${urlStr}`));
    });
    req.write(data);
    req.end();
  });
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
