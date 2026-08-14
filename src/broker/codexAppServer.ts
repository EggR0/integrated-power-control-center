import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as readline from "readline";
import { AgentCapability, AgentAdapter, AgentStateKind, ProviderId, TaskEnvelope } from "./protocol";

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, any>;
  error?: { message?: string; code?: number };
};

type PendingRequest = { resolve: (value: any) => void; reject: (error: Error) => void };
type ServerRequestHandler = (message: JsonRpcMessage) => void | Promise<void>;

/** Minimal stable stdio client for the documented Codex app-server protocol. */
export class CodexAppServerAdapter implements AgentAdapter {
  public readonly provider: ProviderId = "openai.codex.app";
  private readonly running = new Map<string, { process: ChildProcessWithoutNullStreams; client?: JsonRpcStdioClient; threadId?: string; turnId?: string }>();

  public constructor(private readonly executable?: string) {}

  public async discover(): Promise<AgentCapability> {
    const candidates = this.executable ? [this.executable] : process.env.INTEGRATED_POWER_CODEX_EXE ? [process.env.INTEGRATED_POWER_CODEX_EXE] : await findCodexCandidates();
    const executable = await firstCallable(candidates) ?? candidates[0];
    const callable = Boolean(executable && await canExecute(executable));
    const installed = isCodexInstalled();
    const stateKind: AgentStateKind = callable ? "available" : installed ? "waiting" : "not_installed";
    const stateLabel = callable ? "사용가능" : installed ? "대기" : "설치X";
    const reason = callable
      ? undefined
      : installed
        ? "Codex 환경이 설치되어 있습니다 (~/.codex). Codex App Server 및 세션 대기 중입니다."
        : "Codex CLI가 설치되어 있지 않거나 PATH에 없습니다.";
    return {
      provider: this.provider,
      label: "Codex App Server",
      available: callable,
      stateKind,
      stateLabel,
      mode: "app-server",
      capabilities: ["leader", "executor", "local-mcp", "code-write", "streaming", "cancel"],
      endpoint: executable,
      reason,
    };
  }

  public async connectConversation(_conversationId: string): Promise<void> {
    // Conversation resume is intentionally scoped to explicit task linkage.
  }

  public async submit(task: TaskEnvelope, prompt: string): Promise<{ text: string; provider: ProviderId }> {
    const candidates = this.executable ? [this.executable] : process.env.INTEGRATED_POWER_CODEX_EXE ? [process.env.INTEGRATED_POWER_CODEX_EXE] : await findCodexCandidates();
    const executable = await firstCallable(candidates);
    if (!executable) throw new Error(candidates.length ? "Codex executable was found but could not be launched by this process; app-server remains disabled." : "Codex CLI is unavailable for app-server stdio.");
    const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
      cwd: task.workspacePath,
      windowsHide: true,
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(executable),
    });
    const client = new JsonRpcStdioClient(child, async (message) => {
      // Keep child-process approvals fail-closed. Integrated Power exposes
      // approvals in its own user-facing control center, not as hidden model
      // prompts inside a delegated Codex process.
      if (typeof message.id === "number") child.stdin.write(`${JSON.stringify({ id: message.id, result: { decision: "decline" } })}\n`);
    });
    this.running.set(task.id, { process: child, client });
    const timeoutMs = Number.parseInt(process.env.INTEGRATED_POWER_CODEX_TIMEOUT_MS ?? "300000", 10);
    const timeout = setTimeout(() => child.kill(), Number.isFinite(timeoutMs) ? Math.max(10_000, timeoutMs) : 300_000);
    try {
      await client.request("initialize", {
        clientInfo: { name: "integrated_power", title: "Integrated Power", version: "0.8.0" },
      });
      client.notify("initialized", {});
      const thread = await client.request("thread/start", {
        cwd: task.workspacePath,
        approvalPolicy: "never",
        sandbox: "workspaceWrite",
        serviceName: "integrated_power",
      });
      const threadId = thread?.thread?.id;
      if (typeof threadId !== "string") throw new Error("Codex app-server did not return a thread id.");
      this.running.set(task.id, { process: child, client, threadId });
      const turn = await client.request("turn/start", {
        threadId,
        cwd: task.workspacePath,
        input: [{ type: "text", text: prompt }],
      });
      const turnId = turn?.turn?.id;
      if (typeof turnId === "string") this.running.set(task.id, { process: child, client, threadId, turnId });
      const text = await client.collectTurn(threadId, turnId);
      return { provider: this.provider, text };
    } finally {
      clearTimeout(timeout);
      this.running.delete(task.id);
      client.close();
      if (!child.killed) child.kill();
    }
  }

  public async cancel(taskId: string): Promise<void> {
    const active = this.running.get(taskId);
    if (!active) return;
    if (active.turnId && active.threadId) {
      try { active.client?.notify("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }); } catch { /* process termination below is the final fallback */ }
    }
    active.process.kill();
  }
}

export class JsonRpcStdioClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly messages: JsonRpcMessage[] = [];
  private readonly waiters: Array<{ resolve: (message: JsonRpcMessage) => void; reject: (error: Error) => void }> = [];
  private readonly reader: readline.Interface;

  public constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly serverRequestHandler?: ServerRequestHandler) {
    this.reader = readline.createInterface({ input: child.stdout });
    this.reader.on("line", (line) => {
      let message: JsonRpcMessage;
      try { message = JSON.parse(line) as JsonRpcMessage; } catch { return; }
      if (typeof message.id === "number" && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? "Codex app-server request failed."));
        else pending.resolve(message.result ?? {});
        return;
      }
      if (typeof message.id === "number" && typeof message.method === "string") {
        void Promise.resolve(this.serverRequestHandler?.(message)).catch(() => undefined);
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(message); else this.messages.push(message);
    });
    child.on("error", (error) => this.rejectAll(error));
    child.on("close", (code) => this.rejectAll(new Error(`Codex app-server exited (${code ?? "unknown"}).`)));
  }

  public request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    return promise;
  }

  public notify(method: string, params: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  public async collectTurn(threadId: string, turnId?: string): Promise<string> {
    let text = "";
    while (true) {
      const message = await this.nextNotification();
      if (message.method === "item/agentMessage/delta") {
        const params = message.params ?? {};
        if (!params.threadId || params.threadId === threadId) text += typeof params.delta === "string" ? params.delta : "";
      }
      if (message.method === "item/completed") {
        const item = message.params?.item as { type?: string; text?: string } | undefined;
        if (item?.type === "agentMessage" && typeof item.text === "string") text = item.text;
      }
      if (message.method === "turn/completed") {
        const turn = message.params?.turn as { id?: string; status?: string; error?: { message?: string } } | undefined;
        if (turnId && turn?.id && turn.id !== turnId) continue;
        if (turn?.status !== "completed") throw new Error(turn?.error?.message ?? `Codex turn ${turn?.status ?? "failed"}.`);
        return text.trim();
      }
    }
  }

  public close(): void {
    this.reader.close();
    this.rejectAll(new Error("Codex app-server connection closed."));
  }

  private nextNotification(): Promise<JsonRpcMessage> {
    const queued = this.messages.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.length = 0;
  }
}

async function findCodexCandidates(): Promise<string[]> {
  const names = process.platform === "win32" ? ["codex.cmd", "codex.exe", "codex"] : ["codex"];
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  for (const name of names) {
    try {
      const result = await execFileAsync(process.platform === "win32" ? "where.exe" : "which", [name], { windowsHide: true, timeout: 3000 });
      const found = String(result.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (found.length) return found;
    } catch { /* try next candidate */ }
  }
  return [];
}

async function firstCallable(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) if (await canExecute(candidate)) return candidate;
  return undefined;
}

async function canExecute(executable: string): Promise<boolean> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  try {
    await promisify(execFile)(executable, ["--version"], {
      windowsHide: true,
      timeout: 5000,
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(executable),
    });
    return true;
  } catch {
    return false;
  }
}

export function isCodexInstalled(): boolean {
  if (process.platform === "win32") {
    const homedir = os.homedir();
    const local = process.env.LOCALAPPDATA || path.join(homedir, "AppData", "Local");
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const candidates = [
      path.join(homedir, ".codex"),
      path.join(local, "OpenAI", "Codex"),
      path.join(local, "Programs", "Codex"),
      path.join(local, "Programs", "ChatGPT"),
      path.join(programFiles, "ChatGPT"),
      path.join(programFiles, "Codex"),
    ];
    if (candidates.some((c) => fs.existsSync(c))) return true;
    const packagesDir = path.join(local, "Packages");
    try {
      if (fs.existsSync(packagesDir)) {
        const entries = fs.readdirSync(packagesDir);
        if (entries.some((e) => e.startsWith("OpenAI.Codex") || e.startsWith("OpenAI.ChatGPT"))) return true;
      }
    } catch { /* best effort */ }
  }
  return fs.existsSync(path.join(os.homedir(), ".codex"));
}

