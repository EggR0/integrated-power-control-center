import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BrokerConflictError, IntegratedPowerBroker } from "./broker";
import { CreateTaskInput, DelegateTaskInput } from "./protocol";
import { integratedPowerProtocolBoundary } from "./protocols";
import { processMcpRequest } from "./mcpServer";
import { AgUiEvent, validateAgUiEvent } from "./protocols";
import { listHostIntegrations, saveHostIntegrationConfig } from "./hostIntegrations";
import { discoverInstallations } from "./installation";
import { chatgptLocalMcpSpec, claudeLocalMcpSpec, getMcpConfigSnippet, registerClaudeLocalMcp } from "./registration";

export interface BrokerServerHandle {
  port: number;
  close(): Promise<void>;
}

export async function startBrokerServer(
  broker: IntegratedPowerBroker,
  requestedPort = 0,
): Promise<BrokerServerHandle> {
  const server = http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    // The desktop control center is a local Tauri webview. This is intentionally
    // loopback-only; the server never binds to a LAN/public interface.
    const origin = request.headers.origin;
    if (origin === "tauri://localhost" || origin === "http://tauri.localhost" || origin === "https://tauri.localhost" || origin === "http://127.0.0.1:5173" || origin === "http://localhost:5173") {
      response.setHeader("Access-Control-Allow-Origin", origin);
    }
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "content-type");
    if (request.method === "OPTIONS") return send(response, 204, {});
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        return send(response, 200, { ok: true, service: "integrated-power-broker" });
      }
      if (request.method === "GET" && url.pathname === "/v1/logs") {
        const requestedLines = Number.parseInt(url.searchParams.get("lines") ?? "160", 10);
        const lines = Number.isFinite(requestedLines) ? Math.min(500, Math.max(20, requestedLines)) : 160;
        const stateRoot = process.env.INTEGRATED_POWER_STATE_ROOT || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "IntegratedPower", "state");
        const logPath = path.join(stateRoot, "broker.log");
        const content = await fs.promises.readFile(logPath, "utf8").catch(() => "");
        return send(response, 200, { path: logPath, lines: content.split(/\r?\n/).filter(Boolean).slice(-lines) });
      }
      if (request.method === "POST" && url.pathname === "/mcp") {
        const payload = await readJson(request) as any;
        if (payload?.method !== "initialize" && request.headers["mcp-protocol-version"] && request.headers["mcp-protocol-version"] !== "2025-06-18") {
          return send(response, 400, { error: "unsupported_mcp_protocol_version" });
        }
        if (payload?.method === "initialize") response.setHeader("MCP-Protocol-Version", "2025-06-18");
        const message = await processMcpRequest(broker, payload);
        if (!message) { response.statusCode = 202; return response.end(); }
        return send(response, 200, message);
      }
      if (request.method === "GET" && url.pathname === "/mcp") {
        response.setHeader("Allow", "POST");
        return send(response, 405, { error: "streamable_http_sse_not_enabled" });
      }
      if (request.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
        const host = request.headers.host || "127.0.0.1:37241";
        return send(response, 200, {
          name: "Integrated Power Broker",
          description: "Local multi-agent task ledger and approval coordinator.",
          version: "0.8.0",
          supportedInterfaces: [{ url: `http://${host}`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
          provider: { organization: "EggR", url: "https://github.com/EggR0/integrated-power" },
          capabilities: { streaming: false, pushNotifications: false },
          defaultInputModes: ["text/plain"],
          defaultOutputModes: ["text/plain"],
          skills: [{ id: "integrated-power-task", name: "Integrated Power task control", description: "Create and coordinate a local task.", tags: ["multi-agent", "control"] }],
          securitySchemes: {},
          securityRequirements: [],
          signatures: [],
        });
      }
      if (request.method === "POST" && url.pathname === "/message:send") {
        const input = await readJson(request) as any;
        const message = input?.message;
        const text = extractA2AText(message);
        const contextId = typeof message?.contextId === "string" && message.contextId ? message.contextId : undefined;
        const task = await broker.createTask({
          title: contextId ? `A2A ${contextId}` : "A2A task",
          goal: text || "A2A task without a text message",
          originProvider: "local.openai-compatible",
          linkedConversationId: contextId,
          privacy: "private",
        });
        return send(response, 200, { task: toA2ATask(task, text) });
      }
      if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        return send(response, 200, { capabilities: await broker.discover() });
      }
      if (request.method === "GET" && url.pathname === "/v1/integrations") {
        return send(response, 200, { integrations: listHostIntegrations() });
      }
      if (request.method === "GET" && url.pathname === "/v1/installation") {
        return send(response, 200, { installations: discoverInstallations() });
      }
      if (request.method === "GET" && url.pathname === "/v1/integrations/claude/spec") {
        return send(response, 200, { spec: claudeLocalMcpSpec(), snippet: getMcpConfigSnippet() });
      }
      if (request.method === "GET" && url.pathname === "/v1/integrations/chatgpt/spec") {
        return send(response, 200, { spec: chatgptLocalMcpSpec(), snippet: getMcpConfigSnippet() });
      }
      if (request.method === "GET" && url.pathname === "/v1/integrations/mcp/spec") {
        return send(response, 200, { spec: claudeLocalMcpSpec(), snippet: getMcpConfigSnippet() });
      }
      if (request.method === "POST" && url.pathname === "/v1/integrations/claude/register") {
        const input = await readJson(request) as { confirm?: boolean };
        return send(response, 200, registerClaudeLocalMcp(input.confirm === true));
      }
      if (request.method === "POST" && url.pathname === "/v1/integrations/config") {
        const input = await readJson(request) as { confirm?: boolean; chatgptMcpUrl?: string; claudeMcpUrl?: string };
        return send(response, 200, { config: saveHostIntegrationConfig({ chatgptMcpUrl: input.chatgptMcpUrl, claudeMcpUrl: input.claudeMcpUrl }, input.confirm === true) });
      }
      if (request.method === "GET" && url.pathname === "/v1/tasks") {
        return send(response, 200, { tasks: broker.listTasks() });
      }
      if (request.method === "GET" && url.pathname === "/v1/approvals") {
        return send(response, 200, { approvals: broker.getApprovals() });
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/tasks/") && url.pathname.endsWith("/stream")) {
        const taskId = decodeURIComponent(url.pathname.slice("/v1/tasks/".length, -"/stream".length));
        if (!broker.getTask(taskId)) return send(response, 404, { error: "task_not_found" });
        return streamTaskEvents(request, response, broker, taskId);
      }
      if (request.method === "GET" && url.pathname.match(/^\/v1\/tasks\/[^/]+\/(proposals|evaluations|evidence|syntheses)$/)) {
        const match = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/(proposals|evaluations|evidence|syntheses)$/)!;
        const taskId = decodeURIComponent(match[1]);
        if (!broker.getTask(taskId)) return send(response, 404, { error: "task_not_found" });
        const collection = match[2];
        if (collection === "proposals") return send(response, 200, { proposals: await broker.listProposals(taskId) });
        if (collection === "evaluations") return send(response, 200, { evaluations: await broker.listEvaluations(taskId) });
        if (collection === "evidence") return send(response, 200, { evidence: await broker.listEvidence(taskId) });
        return send(response, 200, { syntheses: await broker.listSyntheses(taskId) });
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/tasks/")) {
        const taskId = decodeURIComponent(url.pathname.slice("/v1/tasks/".length));
        const task = broker.getTask(taskId);
        if (!task) return send(response, 404, { error: "task_not_found" });
        return send(response, 200, { task, events: await broker.events(taskId) });
      }
      if (request.method === "POST" && url.pathname === "/v1/tasks") {
        const task = await broker.createTask(await readJson(request) as CreateTaskInput);
        return send(response, 201, { task });
      }
      if (request.method === "POST" && url.pathname === "/a2a/tasks") {
        const input = await readJson(request) as {
          id?: string;
          message?: { parts?: Array<{ kind?: string; text?: string }> };
          contextId?: string;
          originProvider?: CreateTaskInput["originProvider"];
          workspacePath?: string;
        };
        const text = input.message?.parts?.map((part) => part.text ?? "").join("\n").trim() ?? "";
        const task = await broker.createTask({
          title: input.contextId ? `A2A ${input.contextId}` : "A2A task",
          goal: text || "A2A task without a text message",
          originProvider: input.originProvider ?? "local.openai-compatible",
          workspacePath: input.workspacePath,
        });
        return send(response, 201, { id: input.id ?? task.id, contextId: task.id, status: { state: "submitted" }, artifacts: [] });
      }
      if (request.method === "POST" && url.pathname === "/v1/tasks/delegate") {
        const event = await broker.delegate(await readJson(request) as DelegateTaskInput);
        return send(response, 202, { event });
      }
      if (request.method === "POST" && url.pathname === "/v1/approvals") {
        const input = await readJson(request) as {
          taskId: string;
          action: "merge" | "external-send" | "publish" | "budget-overage" | "connect";
          description: string;
          requestedBy: "user" | "broker";
          expectedRevision?: number;
          idempotencyKey?: string;
        };
        const approval = await broker.requestApproval(
          input.taskId,
          input.action,
          input.description,
          input.requestedBy === "user" ? "user" : "broker",
          input.expectedRevision,
          input.idempotencyKey,
        );
        return send(response, 201, { approval });
      }
      if (request.method === "POST" && url.pathname.startsWith("/v1/approvals/") && url.pathname.endsWith("/approve")) {
        const approvalId = decodeURIComponent(url.pathname.slice("/v1/approvals/".length, -"/approve".length));
        const input = await readJson(request) as { expectedRevision?: number; idempotencyKey?: string };
        await broker.approve(approvalId, input.expectedRevision, input.idempotencyKey);
        return send(response, 200, { ok: true });
      }
      if (request.method === "POST" && url.pathname.startsWith("/v1/tasks/") && url.pathname.endsWith("/cancel")) {
        const taskId = decodeURIComponent(url.pathname.slice("/v1/tasks/".length, -"/cancel".length));
        const input = await readJson(request) as { expectedRevision: number; idempotencyKey?: string };
        await broker.cancel(taskId, input.expectedRevision, input.idempotencyKey);
        return send(response, 200, { ok: true });
      }
      if (request.method === "POST" && url.pathname.startsWith("/v1/tasks/") && url.pathname.endsWith("/merge")) {
        const taskId = decodeURIComponent(url.pathname.slice("/v1/tasks/".length, -"/merge".length));
        const input = await readJson(request) as { expectedRevision: number; idempotencyKey?: string };
        const commit = await broker.mergeTask(taskId, input.expectedRevision, input.idempotencyKey);
        return send(response, 200, { ok: true, commit });
      }
      return send(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof BrokerConflictError) {
        const taskId = request.url ? new URL(request.url, "http://127.0.0.1").pathname.match(/tasks\/([^/]+)/)?.[1] : undefined;
        return send(response, 409, { error: error.message, currentRevision: error.currentRevision, task: taskId ? broker.getTask(decodeURIComponent(taskId)) : undefined });
      }
      return send(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function streamTaskEvents(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  broker: IntegratedPowerBroker,
  taskId: string,
): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("X-AG-UI-Version", "1");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  let cursor = 0;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const cleanup = () => {
    closed = true;
    if (timer) clearTimeout(timer);
  };
  request.on("close", cleanup);
  const pump = async () => {
    if (closed) return;
    try {
      const events = await broker.events(taskId);
      for (const event of events.slice(cursor)) {
        const mapped = mapAgUiEvent(event);
        if (mapped) {
          const validated = validateAgUiEvent(mapped);
          response.write(`event: ${validated.type}\ndata: ${JSON.stringify(validated)}\n\n`);
        }
        if (event.type === "task.proposal") {
          const messageStart = validateAgUiEvent({ type: "TEXT_MESSAGE_START", messageId: event.id, role: "assistant", timestamp: Date.parse(event.createdAt) || Date.now() });
          response.write(`event: ${messageStart.type}\ndata: ${JSON.stringify(messageStart)}\n\n`);
          const toolEnd: AgUiEvent = { type: "TOOL_CALL_END", toolCallId: (event.payload as { delegationEventId?: string })?.delegationEventId ?? event.id, timestamp: Date.parse(event.createdAt) || Date.now() } as any;
          const validatedToolEnd = validateAgUiEvent(toolEnd);
          response.write(`event: ${validatedToolEnd.type}\ndata: ${JSON.stringify(validatedToolEnd)}\n\n`);
          const messageEnd = validateAgUiEvent({ type: "TEXT_MESSAGE_END", messageId: event.id, timestamp: Date.parse(event.createdAt) || Date.now() });
          response.write(`event: ${messageEnd.type}\ndata: ${JSON.stringify(messageEnd)}\n\n`);
        }
      }
      cursor = events.length;
      const terminal = events.some((event) => ["task.completed", "task.failed", "task.cancelled", "task.merged"].includes(event.type));
      if (terminal) return response.end();
    } catch (error) {
      const event: AgUiEvent = { type: "RUN_ERROR", runId: taskId, message: error instanceof Error ? error.message : String(error), timestamp: Date.now() } as any;
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      return response.end();
    }
    timer = setTimeout(() => void pump(), 500);
  };
  void pump();
}

function mapAgUiEvent(event: Awaited<ReturnType<IntegratedPowerBroker["events"]>>[number]): AgUiEvent | undefined {
  const timestamp = Date.parse(event.createdAt) || Date.now();
  if (event.type === "task.created") return { type: "RUN_STARTED", runId: event.taskId, threadId: event.taskId, timestamp } as any;
  if (event.type === "task.delegated") return { type: "TOOL_CALL_START", toolCallId: event.id, toolCallName: `delegate:${event.actor}`, timestamp } as any;
  if (event.type === "task.proposal") {
    const content = (event.payload as { content?: string })?.content ?? "";
    return { type: "TEXT_MESSAGE_CONTENT", messageId: event.id, delta: content, timestamp } as any;
  }
  if (["task.completed", "task.merged"].includes(event.type)) return { type: "RUN_FINISHED", runId: event.taskId, threadId: event.taskId, outcome: { type: "success" }, timestamp } as any;
  if (event.type === "task.conflict") return { type: "RUN_ERROR", runId: event.taskId, message: String((event.payload as { error?: string })?.error ?? "merge conflict"), timestamp } as any;
  if (event.type === "task.failed") return { type: "RUN_ERROR", runId: event.taskId, message: String((event.payload as { error?: string })?.error ?? "task failed"), timestamp } as any;
  if (event.type === "task.cancelled") return { type: "RUN_ERROR", runId: event.taskId, message: "task cancelled", timestamp } as any;
  return undefined;
}

function send(response: http.ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.end(JSON.stringify(value));
}

function extractA2AText(message: any): string {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts.map((part: any) => part?.content?.$case === "text" ? part.content.value : part?.text ?? "").filter(Boolean).join("\n").trim();
}

function toA2ATask(task: Awaited<ReturnType<IntegratedPowerBroker["listTasks"]>>[number], text: string): Record<string, any> {
  return {
    id: task.id,
    contextId: task.linkedConversationId || task.id,
    status: {
      state: task.status === "completed" ? "TASK_STATE_COMPLETED" : task.status === "failed" ? "TASK_STATE_FAILED" : task.status === "cancelled" ? "TASK_STATE_CANCELED" : "TASK_STATE_SUBMITTED",
      message: text ? { messageId: `${task.id}:input`, contextId: task.linkedConversationId || task.id, role: "ROLE_USER", parts: [{ content: { $case: "text", value: text }, mediaType: "text/plain" }], metadata: {}, extensions: [], referenceTaskIds: [] } : undefined,
      timestamp: task.updatedAt,
    },
    artifacts: [],
    history: [],
    metadata: { integratedPowerTaskId: task.id, revision: task.revision },
  };
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}
