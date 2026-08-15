import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as http from "http";
import { IntegratedPowerBroker } from "./broker";
import { CreateTaskInput, DelegateTaskInput } from "./protocol";
import { integratedPowerProtocolBoundary } from "./protocols";

interface McpRequest {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
}

/** Official MCP SDK stdio bridge. The old request switch remains only as a
 * compatibility helper for the loopback HTTP edge and tests. */
export async function startMcpStdioServer(broker: IntegratedPowerBroker): Promise<void> {
  const server = createOfficialMcpServer(broker);
  await server.connect(new StdioServerTransport());
}

export function createOfficialMcpServer(broker: IntegratedPowerBroker): McpServer {
  const server = new McpServer({ name: "integrated-power", version: "0.8.0" });
  for (const tool of integratedPowerProtocolBoundary.mcp.tools) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: z.record(z.string(), z.unknown()),
      annotations: { readOnlyHint: tool.name.includes("get_status") || tool.name.includes("list_") || tool.name.includes("choose_route") },
    }, async (args: Record<string, unknown>) => {
      const result = await callTool(broker, tool.name, args as Record<string, any>);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
    });
  }
  return server;
}

export async function processOfficialMcpHttpRequest(
  broker: IntegratedPowerBroker,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  payload: unknown,
): Promise<void> {
  const server = createOfficialMcpServer(broker);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(request, response, payload);
}

export async function processMcpRequest(broker: IntegratedPowerBroker, request: McpRequest): Promise<Record<string, any> | undefined> {
  if (request.method?.startsWith("notifications/")) return undefined;
  if (request.id === undefined) return undefined;
  let result: unknown;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: request.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "integrated-power", version: "0.8.0" },
      };
      break;
    case "ping":
      result = {};
      break;
    case "tools/list":
      result = { tools: integratedPowerProtocolBoundary.mcp.tools.map((tool) => ({ ...tool, annotations: { readOnlyHint: tool.name.includes("get_status") } })) };
      break;
    case "tools/call":
      result = await callTool(broker, request.params?.name, request.params?.arguments ?? {});
      break;
    default:
      return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Unsupported MCP method: ${request.method ?? ""}` } };
  }
  const response = request.method === "tools/call"
    ? { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result }
    : result;
  return { jsonrpc: "2.0", id: request.id, result: response };
}

async function callTool(broker: IntegratedPowerBroker, name: string, args: Record<string, any>): Promise<unknown> {
  const currentTask = args.taskId ? broker.getTask(String(args.taskId)) : undefined;
  const currentRevision = currentTask?.revision;
  const targetRevision = optionalRevision(args.expectedRevision) ?? currentRevision ?? 1;

  switch (name) {
    case "integrated_power_create_task": {
      const workspacePath = args.workspacePath?.trim() || process.env.INTEGRATED_POWER_DEFAULT_WORKSPACE || "d:\\Workspace\\Integrated POWER";
      return { task: await broker.createTask({ ...args, workspacePath } as CreateTaskInput) };
    }
    case "integrated_power_delegate":
      return { event: await broker.delegate({ ...args, expectedRevision: targetRevision } as DelegateTaskInput) };
    case "integrated_power_debate":
      return { result: await broker.debate({ taskId: String(args.taskId), providers: Array.isArray(args.providers) ? args.providers : [], prompt: String(args.prompt ?? ""), expectedRevision: targetRevision, idempotencyKey: args.idempotencyKey }) };
    case "integrated_power_get_status":
      return { task: broker.getTask(String(args.taskId)), approvals: broker.getApprovals() };
    case "integrated_power_list_tasks":
      return { tasks: broker.listTasks() };
    case "integrated_power_list_capabilities":
      return { capabilities: await broker.discover() };
    case "integrated_power_choose_route":
      return { decision: broker.chooseRoute(String(args.taskId)) };
    case "integrated_power_request_approval":
      return { approval: await broker.requestApproval(String(args.taskId), args.action, String(args.description ?? ""), args.requestedBy ?? "user", targetRevision, args.idempotencyKey) };
    case "integrated_power_cancel":
      await broker.cancel(String(args.taskId), targetRevision, args.idempotencyKey);
      return { ok: true };
    case "integrated_power_merge":
      return { commit: await broker.mergeTask(String(args.taskId), targetRevision, args.idempotencyKey) };
    case "integrated_power_record_evaluation": {
      const evaluation = args.evaluation || {};
      const score = Number(args.score ?? evaluation.score ?? 1);
      const rationale = String(args.rationale ?? evaluation.rationale ?? "");
      const evaluator = args.evaluator ?? "google.antigravity.ide";
      const proposalId = String(args.proposalId ?? evaluation.proposalId ?? "");
      return { event: await broker.recordEvaluation({ taskId: String(args.taskId), proposalId, evaluator, score, rationale, expectedRevision: targetRevision, idempotencyKey: args.idempotencyKey }) };
    }
    case "integrated_power_record_evidence": {
      const evidence = args.evidence || {};
      const kind = args.kind ?? evidence.kind ?? "runtime";
      const label = String(args.label ?? evidence.label ?? "runtime check");
      const passed = Boolean(args.passed ?? evidence.passed ?? true);
      const details = String(args.details ?? evidence.details ?? "");
      return { event: await broker.recordEvidence({ taskId: String(args.taskId), kind, label, passed, details, expectedRevision: targetRevision, idempotencyKey: args.idempotencyKey }) };
    }
    case "integrated_power_quick_delegate":
      return await broker.quickDelegate(args as any);
    case "integrated_power_get_token_status":
      return await broker.getTokenStatus();
    case "integrated_power_synthesize":
      return { event: await broker.synthesize({ taskId: String(args.taskId), provider: args.provider ?? "google.antigravity.ide", content: String(args.content ?? ""), dissent: Array.isArray(args.dissent) ? args.dissent.map(String) : [], confidence: Number(args.confidence ?? 1), evidenceIds: Array.isArray(args.evidenceIds) ? args.evidenceIds.map(String) : [], expectedRevision: targetRevision, idempotencyKey: args.idempotencyKey }) };
    default:
      throw new Error(`Unknown Integrated Power MCP tool: ${name}`);
  }
}

function optionalRevision(value: unknown): number | undefined {
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 0 ? revision : undefined;
}
