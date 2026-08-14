import { AGUIEvent as OfficialAgUiEvent, EventSchemas, EventType } from "@ag-ui/core";

/** Wire-level boundaries shared by the broker and host-specific integrations.
 * These deliberately stay dependency-free so an MCP/A2A/AG-UI SDK can be
 * added at the edge without coupling the encrypted task ledger to a vendor.
 */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface A2ATaskEnvelope {
  id: string;
  contextId?: string;
  status: "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled";
  message?: { role: "user" | "agent"; parts: Array<{ kind: "text"; text: string }> };
  artifacts?: Array<{ name: string; parts: Array<{ kind: "text"; text: string }> }>;
}

export type AgUiEvent = OfficialAgUiEvent;

export function validateAgUiEvent(value: unknown): AgUiEvent {
  return EventSchemas.parse(value);
}

export interface IntegratedPowerProtocolBoundary {
  mcp: { tools: McpToolDescriptor[]; transports: Array<"stdio" | "streamable-http"> };
  a2a: { agentCardPath: string; taskEndpoint: string; protocolVersion: "1.0" };
  agUi: { eventVersion: "1"; eventTypes: AgUiEvent["type"][] };
}

export const integratedPowerProtocolBoundary: IntegratedPowerProtocolBoundary = {
  mcp: {
    transports: ["stdio", "streamable-http"],
    tools: [
      {
        name: "integrated_power_create_task",
        description: "Create an explicitly scoped task in the local Integrated Power ledger.",
        inputSchema: { type: "object", properties: { title: { type: "string" }, goal: { type: "string" }, originProvider: { type: "string" }, workspacePath: { type: "string" }, privacy: { type: "string", enum: ["local", "private", "external-approved"] } }, required: ["title", "goal", "originProvider"] },
      },
      {
        name: "integrated_power_delegate",
        description: "Delegate a task to an available provider using an expected revision.",
        inputSchema: { type: "object", properties: { taskId: { type: "string" }, provider: { type: "string" }, prompt: { type: "string" }, expectedRevision: { type: "integer" }, idempotencyKey: { type: "string" } }, required: ["taskId", "provider", "prompt", "expectedRevision"] },
      },
      {
        name: "integrated_power_debate",
        description: "Run bounded independent proposals and return anonymized proposal records.",
        inputSchema: { type: "object", properties: { taskId: { type: "string" }, providers: { type: "array", items: { type: "string" }, maxItems: 4 }, prompt: { type: "string" }, expectedRevision: { type: "integer" }, idempotencyKey: { type: "string" } }, required: ["taskId", "providers", "prompt", "expectedRevision"] },
      },
      {
        name: "integrated_power_get_status",
        description: "Read one explicitly linked task and pending approvals.",
        inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
      },
      {
        name: "integrated_power_list_tasks",
        description: "List only tasks created through Integrated Power or explicitly linked to it.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "integrated_power_list_capabilities",
        description: "Discover available providers and explain unavailable official bridges.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "integrated_power_choose_route",
        description: "Return the current local routing decision without submitting work.",
        inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
      },
      {
        name: "integrated_power_request_approval",
        description: "Request user approval before merge, publication, external transfer, or budget overage.",
        inputSchema: { type: "object", properties: { taskId: { type: "string" }, action: { type: "string", enum: ["merge", "external-send", "publish", "budget-overage", "connect"] }, description: { type: "string" }, requestedBy: { type: "string", enum: ["user", "broker"] }, expectedRevision: { type: "integer" }, idempotencyKey: { type: "string" } }, required: ["taskId", "action", "description", "expectedRevision"] },
      },
      {
        name: "integrated_power_cancel",
        description: "Cancel a linked task using its current revision.",
        inputSchema: { type: "object", properties: { taskId: { type: "string" }, expectedRevision: { type: "integer" }, idempotencyKey: { type: "string" } }, required: ["taskId", "expectedRevision"] },
      },
      {
        name: "integrated_power_merge",
        description: "Merge an approved isolated worktree into the base branch.",
        inputSchema: { type: "object", properties: { taskId: { type: "string" }, expectedRevision: { type: "integer" }, idempotencyKey: { type: "string" } }, required: ["taskId", "expectedRevision"] },
      },
      {
        name: "integrated_power_record_evaluation",
        description: "Record an anonymized cross-evaluation of a proposal.",
        inputSchema: { type: "object", properties: { taskId: { type: "string" }, proposalId: { type: "string" }, evaluator: { type: "string" }, score: { type: "number" }, rationale: { type: "string" }, expectedRevision: { type: "integer" }, idempotencyKey: { type: "string" } }, required: ["taskId", "proposalId", "evaluator", "score", "rationale", "expectedRevision"] },
      },
      {
        name: "integrated_power_record_evidence",
        description: "Attach a test, source, diff, manual, or runtime verification record.",
        inputSchema: { type: "object", properties: { taskId: { type: "string" }, kind: { type: "string", enum: ["test", "diff", "source", "manual", "runtime"] }, label: { type: "string" }, passed: { type: "boolean" }, details: { type: "string" }, expectedRevision: { type: "integer" }, idempotencyKey: { type: "string" } }, required: ["taskId", "kind", "label", "passed", "details", "expectedRevision"] },
      },
      {
        name: "integrated_power_synthesize",
        description: "Persist a synthesis with dissent, confidence, and evidence references.",
        inputSchema: { type: "object", properties: { taskId: { type: "string" }, provider: { type: "string" }, content: { type: "string" }, dissent: { type: "array", items: { type: "string" } }, confidence: { type: "number" }, evidenceIds: { type: "array", items: { type: "string" } }, expectedRevision: { type: "integer" }, idempotencyKey: { type: "string" } }, required: ["taskId", "provider", "content", "confidence", "expectedRevision"] },
      },
    ],
  },
  a2a: { agentCardPath: "/.well-known/agent-card.json", taskEndpoint: "/message:send", protocolVersion: "1.0" },
  agUi: {
    eventVersion: "1",
    eventTypes: [EventType.RUN_STARTED, EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END, EventType.TOOL_CALL_START, EventType.TOOL_CALL_END, EventType.RUN_FINISHED, EventType.RUN_ERROR],
  },
};
