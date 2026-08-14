import { execFile } from "child_process";
import { promisify } from "util";
import { AgentAdapter, AgentCapability, ProviderId, TaskEnvelope } from "./protocol";
import { legacyLocalRunnerAvailable, runLegacyLocalLlm } from "./localRunner";
import { CodexAppServerAdapter } from "./codexAppServer";
import { inspectHostIntegration } from "./hostIntegrations";
import { findExecutableOnPath } from "./executable";

const execFileAsync = promisify(execFile);

export class DiscoveryAdapter implements AgentAdapter {
  public constructor(
    public readonly provider: ProviderId,
    private readonly executableNames: string[],
    private readonly mode: AgentCapability["mode"],
    private readonly baseCapabilities: AgentCapability["capabilities"],
    private readonly label: string,
  ) {}

  public async discover(): Promise<AgentCapability> {
    const executable = findExecutableOnPath(this.executableNames);
    if (!executable) {
      return {
        provider: this.provider,
        label: this.label,
        available: false,
        stateKind: "not_installed",
        stateLabel: "설치X",
        mode: this.mode,
        capabilities: this.baseCapabilities,
        reason: `${this.executableNames[0] || this.label}가 설치되어 있지 않거나 PATH에 없습니다.`,
      };
    }
    return {
      provider: this.provider,
      label: this.label,
      available: true,
      stateKind: "available",
      stateLabel: "사용가능",
      mode: this.mode,
      capabilities: this.baseCapabilities,
      endpoint: executable,
    };
  }

  public async connectConversation(_conversationId: string): Promise<void> {
    // Official GUI adapters may override this. Discovery-only adapters never
    // inspect or import unlinked conversation history.
  }

  public async submit(_task: TaskEnvelope, _prompt: string): Promise<{ text: string; provider: ProviderId }> {
    throw new Error(`${this.provider} is discovered but has no official submission bridge yet.`);
  }

  public async cancel(_taskId: string): Promise<void> {
    throw new Error(`${this.provider} does not expose a cancellation bridge yet.`);
  }
}

/** Explicitly surfaced GUI integrations. No conversation scraping or credential
 * extraction is attempted; they become active only when an official plugin/MCP
 * bridge is installed and a later adapter supplies its transport. */
export class DeferredGuiAdapter extends DiscoveryAdapter {
  public constructor(
    provider: ProviderId,
    label: string,
    private readonly bridgeHint: string,
    private readonly bridgeMode: AgentCapability["mode"] = "gui",
  ) {
    super(provider, [], bridgeMode, ["leader", "executor", "remote-mcp", "streaming"], label);
  }

  public override async discover(): Promise<AgentCapability> {
    return {
      provider: this.provider,
      label: this.bridgeHint,
      available: false,
      stateKind: "not_installed",
      stateLabel: "설치X",
      mode: this.bridgeMode,
      capabilities: ["leader", "executor", "remote-mcp", "streaming"],
      reason: `Waiting for an official ${this.bridgeHint} plugin/MCP submission bridge; linked conversations remain private.`,
    };
  }
}

/** Inbound MCP host adapter. ChatGPT/Claude call the broker's tools from their
 * own UI; they are not driven by scraping or a hidden GUI automation process. */
export class HostMcpAdapter extends DeferredGuiAdapter {
  public constructor(provider: ProviderId, label: string) {
    super(provider, label, label);
  }

  public override async discover(): Promise<AgentCapability> {
    const status = inspectHostIntegration(this.provider);
    return {
      provider: status.provider,
      label: status.label,
      available: status.available,
      stateKind: status.stateKind,
      stateLabel: status.stateLabel,
      mode: status.mode,
      capabilities: status.capabilities,
      endpoint: status.endpoint || status.configPath,
      reason: status.reason,
    };
  }

  public override async submit(_task: TaskEnvelope, _prompt: string): Promise<{ text: string; provider: ProviderId }> {
    throw new Error(`${this.provider} is an inbound MCP host. Invoke Integrated Power tools from that host instead of asking the broker to drive its GUI.`);
  }
}

export class ChatGptGuiAdapter extends HostMcpAdapter {
  public constructor() { super("openai.chatgpt.app", "ChatGPT"); }
}

export class ClaudeDesktopAdapter extends HostMcpAdapter {
  public constructor() { super("anthropic.claude.desktop", "Claude Desktop"); }
}

export class CoworkAdapter extends HostMcpAdapter {
  public constructor() { super("anthropic.cowork", "Claude Cowork"); }
}

export class GrokAdapter extends DeferredGuiAdapter {
  public constructor() { super("xai.grok", "Grok", "xAI Grok", "api"); }
}

/** Optional A2A peer adapter. The official SDK is loaded only when a
 * user-configured peer exists, so the VSIX remains usable on older VS Code
 * runtimes while the standalone Node 22+ broker can use the v1 SDK. */
export class A2APeerAdapter implements AgentAdapter {
  public readonly provider: `local.a2a.${string}`;
  private client: any;
  private readonly endpoint: string;

  public constructor(endpoint: string, providerSuffix?: string) {
    this.endpoint = endpoint.replace(/\/$/, "");
    const suffix = (providerSuffix || this.endpoint.replace(/[^A-Za-z0-9]+/g, "-")).replace(/^-+|-+$/g, "") || "peer";
    this.provider = `local.a2a.${suffix}`;
  }

  public async discover(): Promise<AgentCapability> {
    try {
      const sdk = loadA2ASdk();
      this.client = await new sdk.ClientFactory().createFromUrl(this.endpoint);
      const mode: AgentCapability["mode"] = isLoopbackEndpoint(this.endpoint) ? "local" : "api";
      return {
        provider: this.provider,
        label: `A2A peer (${this.endpoint})`,
        available: true,
        mode,
        capabilities: ["executor", "remote-mcp", "streaming", "cancel"],
        endpoint: this.endpoint,
      };
    } catch (error) {
      return {
        provider: this.provider,
        label: `A2A peer (${this.endpoint})`,
        available: false,
        mode: isLoopbackEndpoint(this.endpoint) ? "local" : "api",
        capabilities: ["executor", "remote-mcp", "streaming", "cancel"],
        endpoint: this.endpoint,
        reason: `Official A2A SDK peer unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  public async connectConversation(_conversationId: string): Promise<void> {}

  public async submit(task: TaskEnvelope, prompt: string): Promise<{ text: string; provider: ProviderId }> {
    if (!this.client) await this.discover();
    if (!this.client) throw new Error(`A2A peer is unavailable: ${this.endpoint}`);
    const result = await this.client.sendMessage({
      tenant: "",
      message: {
        messageId: task.id,
        contextId: task.linkedConversationId || task.id,
        role: 1,
        parts: [{ content: { $case: "text", value: prompt }, mediaType: "text/plain" }],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: undefined,
      metadata: { integratedPowerTaskId: task.id },
    });
    return { provider: this.provider, text: extractA2AText(result) };
  }

  public async cancel(taskId: string): Promise<void> {
    if (!this.client) return;
    await this.client.cancelTask({ tenant: "", id: taskId, metadata: {} }).catch(() => undefined);
  }
}

export class AgyCliAdapter implements AgentAdapter {
  public readonly provider = "google.antigravity.ide" as const;
  private readonly running = new Map<string, AbortController>();

  public async discover(): Promise<AgentCapability> {
    const executable = findExecutableOnPath(
      process.platform === "win32" ? ["agy.cmd", "agy.exe", "agy.bat", "agy"] : ["agy"],
    );
    const available = Boolean(executable);
    return {
      provider: this.provider,
      label: "Antigravity IDE / Agy",
      available,
      stateKind: available ? "available" : "not_installed",
      stateLabel: available ? "사용가능" : "설치X",
      mode: "cli",
      capabilities: ["leader", "executor", "local-mcp", "code-write", "streaming", "cancel"],
      endpoint: executable,
      reason: executable ? undefined : "agy CLI가 설치되어 있지 않거나 PATH에 없습니다.",
    };
  }

  public async connectConversation(_conversationId: string): Promise<void> {
    // Explicit conversation IDs are passed only when the user links one.
  }

  public async submit(task: TaskEnvelope, prompt: string): Promise<{ text: string; provider: "google.antigravity.ide" }> {
    const executable = findExecutableOnPath(
      process.platform === "win32" ? ["agy.cmd", "agy.exe", "agy.bat", "agy"] : ["agy"],
    );
    if (!executable) throw new Error("Agy CLI is not installed or not on PATH.");
    const controller = new AbortController();
    this.running.set(task.id, controller);
    try {
      const args = [
        "-p",
        prompt,
        "--mode",
        "accept-edits",
      ];
      if (task.workspacePath) args.push("--add-dir", task.workspacePath);
      if (task.linkedConversationId) args.push("--conversation", task.linkedConversationId);
      const result = await execFileAsync(executable, args, {
        windowsHide: true,
        timeout: 5 * 60 * 1000,
        maxBuffer: 16 * 1024 * 1024,
        signal: controller.signal,
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(executable),
      });
      return { provider: this.provider, text: String(result.stdout).trim() };
    } finally {
      this.running.delete(task.id);
    }
  }

  public async cancel(taskId: string): Promise<void> {
    this.running.get(taskId)?.abort();
  }
}

export class OpenAiCompatibleLocalAdapter implements AgentAdapter {
  public readonly provider = "local.openai-compatible" as const;
  private endpoint: string;
  private model: string | undefined;
  private readonly running = new Map<string, AbortController>();

  public constructor(endpoint = process.env.INTEGRATED_POWER_LOCAL_ENDPOINT ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434") {
    let normalized = endpoint.includes("://") ? endpoint : `http://${endpoint}`;
    if (/^https?:\/\/0\.0\.0\.0(?::\d+)?$/i.test(normalized)) {
      normalized = normalized.replace("0.0.0.0", "127.0.0.1");
    }
    if (/^https?:\/\/[^/]+$/i.test(normalized) && !/:\d+$/i.test(normalized)) {
      normalized += ":11434";
    }
    this.endpoint = normalized.replace(/\/$/, "");
  }

  public async discover(): Promise<AgentCapability> {
    if (process.platform !== "win32") {
      return { provider: this.provider, label: "Local LLM (legacy policy adapter)", available: false, stateKind: "not_installed", stateLabel: "설치X", mode: "local", capabilities: ["executor", "local-mcp", "streaming"], endpoint: this.endpoint, reason: "The Windows legacy selector/runner is the current first-wave authority." };
    }
    try {
      if (!legacyLocalRunnerAvailable()) throw new Error("Legacy selector/runner scripts are not installed.");
      const scriptsRoot = process.env.INTEGRATED_POWER_LOCAL_SCRIPTS || "legacy-vsix-scripts";
      return {
        provider: this.provider,
        label: "Local LLM (legacy selector/runner)",
        available: true,
        stateKind: "available",
        stateLabel: "사용가능",
        mode: "local",
        capabilities: ["executor", "local-mcp", "streaming"],
        model: process.env.INTEGRATED_POWER_LOCAL_MODEL || "qwen3.6:27b",
        endpoint: this.endpoint,
        reason: `Selection is delegated to Select-LocalLLMModel.ps1 (${scriptsRoot}).`,
      };
    } catch (error) {
      return { provider: this.provider, label: "Local LLM (legacy selector/runner)", available: false, stateKind: "not_installed", stateLabel: "설치X", mode: "local", capabilities: ["executor", "local-mcp", "streaming"], endpoint: this.endpoint, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  public async connectConversation(_conversationId: string): Promise<void> {}

  public async submit(task: TaskEnvelope, prompt: string): Promise<{ text: string; provider: "local.openai-compatible" }> {
    const capability = await this.discover();
    if (!capability.available) throw new Error(capability.reason ?? "Local model unavailable.");
    const controller = new AbortController();
    this.running.set(task.id, controller);
    const timeoutMs = Number.parseInt(process.env.INTEGRATED_POWER_LOCAL_TIMEOUT_MS ?? "120000", 10);
    const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? Math.max(10_000, timeoutMs) : 120_000);
    try {
      const result = await runLegacyLocalLlm(task, prompt, this.endpoint);
      this.model = result.model;
      return { provider: this.provider, text: result.text };
    } finally {
      clearTimeout(timeout);
      this.running.delete(task.id);
    }
  }

  public async cancel(taskId: string): Promise<void> {
    this.running.get(taskId)?.abort();
  }
}

export function createFirstWaveAdapters(): AgentAdapter[] {
  const adapters: AgentAdapter[] = [
    new AgyCliAdapter(),
    new CodexAppServerAdapter(),
    new DiscoveryAdapter(
      "google.antigravity.app",
      process.platform === "win32" ? ["Antigravity.exe"] : ["antigravity"],
      "gui",
      ["leader", "executor", "local-mcp", "streaming"],
      "Antigravity",
    ),
    new ChatGptGuiAdapter(),
    new ClaudeDesktopAdapter(),
    new CoworkAdapter(),
    new GrokAdapter(),
    new OpenAiCompatibleLocalAdapter(),
  ];
  const configuredPeers = parseA2APeers(process.env.INTEGRATED_POWER_A2A_ENDPOINTS);
  adapters.push(...configuredPeers.map((endpoint) => new A2APeerAdapter(endpoint)));
  return adapters;
}

function loadA2ASdk(): { ClientFactory: new (...args: any[]) => { createFromUrl(url: string): Promise<any> } } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("@a2a-js/sdk/client");
}

function parseA2APeers(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && /^https?:\/\//i.test(item));
  } catch { return []; }
}

function isLoopbackEndpoint(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch { return false; }
}

function extractA2AText(result: any): string {
  if (result?.status?.message?.parts) return extractA2AText(result.status.message);
  const parts = Array.isArray(result?.parts) ? result.parts : Array.isArray(result?.message?.parts) ? result.message.parts : [];
  return parts.map((part: any) => part?.content?.$case === "text" ? part.content.value : part?.text ?? "").filter(Boolean).join("\n") || JSON.stringify(result);
}

/** Compatibility export for older tests/clients. Production routing uses the
 * legacy PowerShell selector through runLegacyLocalLlm. */
export function selectPreferredLocalModel(models: string[]): string | undefined {
  const normalized = models.filter(Boolean);
  const preference = [
    "qwen3.6:27b",
    "qwen2.5-coder:32b",
    "qwen3.6:latest",
    "gpt-oss:20b",
    "deepseek-coder-v2:latest",
    "qwen2.5:32b",
    "qwen-32b-4k:latest",
    "llama3.1:70b-instruct-q4_K_M",
    "hf.co/bartowski/nvidia_Llama-3_3-Nemotron-Super-49B-v1-GGUF:Q5_K_M",
    "qwen2.5:7b",
    "qwen2.5:1.5b",
  ];
  for (const preferred of preference) if (normalized.includes(preferred)) return preferred;
  return normalized.sort((left, right) => right.localeCompare(left))[0];
}
