import { randomUUID } from "crypto";

export type ProviderId =
  | "google.antigravity.ide"
  | "google.antigravity.app"
  | "openai.codex.app"
  | "openai.chatgpt.app"
  | "anthropic.claude.desktop"
  | "anthropic.cowork"
  | "xai.grok"
  | `local.${string}`;

export type LegacyRoute = "main_agent" | "codex" | "local_llm";
export type TaskStatus =
  | "created"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskEventType =
  | "task.created"
  | "task.linked"
  | "task.delegated"
  | "task.proposal"
  | "task.evaluation"
  | "task.evidence"
  | "task.synthesis"
  | "task.approval_requested"
  | "task.approved"
  | "task.merged"
  | "task.rejected"
  | "task.conflict"
  | "task.completed"
  | "task.failed"
  | "task.cancelled";

export interface BudgetPolicy {
  maxUsd?: number;
  maxTokens?: number;
  maxParticipants: number;
  allowApiSpend: boolean;
}

export interface TaskEnvelope {
  id: string;
  title: string;
  goal: string;
  workspacePath?: string;
  baseWorkspacePath?: string;
  isolatedWorkspacePath?: string;
  /** All code-writing sandboxes created for this task, keyed by provider. */
  isolatedWorkspaces?: Array<{ provider: ProviderId; root: string; branch: string }>;
  contextFiles: string[];
  originProvider: ProviderId;
  linkedConversationId?: string;
  privacy: "local" | "private" | "external-approved";
  status: TaskStatus;
  revision: number;
  delegationDepth: number;
  /** Providers that have contributed to this task. Kept separate from
   * delegationDepth so a bounded multi-agent review can use up to four
   * participants without allowing recursive delegation. */
  participants: ProviderId[];
  budget: BudgetPolicy;
  createdAt: string;
  updatedAt: string;
}

export type AgentStateKind = "not_installed" | "unlinked" | "waiting" | "error" | "available";

export interface AgentCapability {
  provider: ProviderId;
  label: string;
  available: boolean;
  stateKind?: AgentStateKind;
  stateLabel?: string;
  mode: "gui" | "app-server" | "cli" | "api" | "local";
  capabilities: Array<
    | "leader"
    | "executor"
    | "local-mcp"
    | "remote-mcp"
    | "code-write"
    | "streaming"
    | "cancel"
  >;
  model?: string;
  endpoint?: string;
  reason?: string;
}

export interface Proposal {
  id: string;
  taskId: string;
  participant: ProviderId;
  anonymizedLabel: string;
  content: string;
  createdAt: string;
}

export interface Evaluation {
  id: string;
  taskId: string;
  evaluator: ProviderId;
  proposalId: string;
  score: number;
  rationale: string;
  createdAt: string;
}

export interface Evidence {
  id: string;
  taskId: string;
  kind: "test" | "diff" | "source" | "manual" | "runtime";
  label: string;
  passed: boolean;
  details: string;
  createdAt: string;
}

export interface Synthesis {
  id: string;
  taskId: string;
  provider: ProviderId;
  content: string;
  dissent: string[];
  confidence: number;
  evidenceIds: string[];
  createdAt: string;
}

export interface EvaluationInput {
  taskId: string;
  proposalId: string;
  evaluator: ProviderId;
  score: number;
  rationale: string;
  expectedRevision: number;
  idempotencyKey?: string;
}

export interface EvidenceInput {
  taskId: string;
  kind: Evidence["kind"];
  label: string;
  passed: boolean;
  details: string;
  expectedRevision: number;
  idempotencyKey?: string;
}

export interface SynthesisInput {
  taskId: string;
  provider: ProviderId;
  content: string;
  dissent?: string[];
  confidence: number;
  evidenceIds?: string[];
  expectedRevision: number;
  idempotencyKey?: string;
}

export interface DebateInput {
  taskId: string;
  providers: ProviderId[];
  prompt: string;
  expectedRevision: number;
  idempotencyKey?: string;
}

export interface ApprovalRequest {
  id: string;
  taskId: string;
  action: "merge" | "external-send" | "publish" | "budget-overage" | "connect";
  description: string;
  requestedBy: ProviderId | "user" | "broker";
  expectedRevision: number;
  createdAt: string;
  expiresAt?: string;
}

export interface TaskEvent<T = unknown> {
  id: string;
  taskId: string;
  type: TaskEventType;
  actor: ProviderId | "broker" | "user";
  expectedRevision: number;
  revision: number;
  idempotencyKey: string;
  createdAt: string;
  payload: T;
}

export interface CreateTaskInput {
  title: string;
  goal: string;
  originProvider: ProviderId;
  workspacePath?: string;
  contextFiles?: string[];
  linkedConversationId?: string;
  privacy?: TaskEnvelope["privacy"];
  budget?: Partial<BudgetPolicy>;
  idempotencyKey?: string;
}

export interface DelegateTaskInput {
  taskId: string;
  provider: ProviderId;
  prompt: string;
  expectedRevision: number;
  idempotencyKey?: string;
  /** Recursive delegation depth; bounded to two by the broker. */
  delegationDepth?: number;
}

export interface ApprovalCommandInput {
  taskId: string;
  action: ApprovalRequest["action"];
  description: string;
  requestedBy: ApprovalRequest["requestedBy"];
  expectedRevision: number;
  idempotencyKey?: string;
}

export interface AgentAdapter {
  readonly provider: ProviderId;
  discover(): Promise<AgentCapability>;
  connectConversation(conversationId: string): Promise<void>;
  submit(task: TaskEnvelope, prompt: string): Promise<{ text: string; provider: ProviderId }>;
  cancel(taskId: string): Promise<void>;
}

export function createTaskId(): string {
  return `task_${randomUUID()}`;
}

export function createEventId(): string {
  return `evt_${randomUUID()}`;
}

export function createIdempotencyKey(): string {
  return randomUUID();
}

export function legacyRouteToProvider(route: LegacyRoute): ProviderId {
  switch (route) {
    case "main_agent":
      return "google.antigravity.ide";
    case "codex":
      return "openai.codex.app";
    case "local_llm":
      return "local.openai-compatible";
  }
}
