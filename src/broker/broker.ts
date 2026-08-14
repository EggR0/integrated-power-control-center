import * as path from "path";
import { EventLedger } from "./ledger";
import {
  AgentAdapter,
  AgentCapability,
  ApprovalRequest,
  CreateTaskInput,
  DelegateTaskInput,
  Evaluation,
  EvaluationInput,
  Evidence,
  EvidenceInput,
  Proposal,
  ProviderId,
  Synthesis,
  SynthesisInput,
  TaskEnvelope,
  TaskEvent,
  createEventId,
  createIdempotencyKey,
  createTaskId,
} from "./protocol";
import { chooseProvider, normalizeBudget } from "./router";
import { abortBaseMerge, createIsolatedWorkspace, mergeIsolatedWorkspace, removeIsolatedWorkspace } from "./workspace";

export class BrokerConflictError extends Error {
  public constructor(public readonly currentRevision: number) {
    super(`Task revision conflict. Current revision is ${currentRevision}.`);
    this.name = "BrokerConflictError";
  }
}

export class IntegratedPowerBroker {
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly capabilities = new Map<string, AgentCapability>();
  private readonly tasks = new Map<string, TaskEnvelope>();
  private readonly idempotency = new Map<string, TaskEvent>();
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly approvedActions = new Set<string>();
  private readonly approvalIdempotency = new Map<string, ApprovalRequest>();
  private readonly createIdempotency = new Map<string, TaskEnvelope>();
  private readonly createInFlight = new Map<string, Promise<TaskEnvelope>>();
  private readonly mergeResults = new Map<string, string>();
  private readonly activeDelegations = new Map<string, number>();
  /** Per-task state transitions are serialized, while provider execution is
   * deliberately kept outside the lock so a user cancellation can interrupt
   * a long-running adapter call. */
  private readonly taskLocks = new Map<string, Promise<void>>();
  private mergeQueue: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly ledger: EventLedger,
    adapters: AgentAdapter[],
  ) {
    for (const adapter of adapters) this.adapters.set(adapter.provider, adapter);
  }

  public async initialize(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      this.capabilities.set(adapter.provider, await adapter.discover());
    }
    const events = await this.ledger.list();
    for (const event of events) this.replay(event);
  }

  public async discover(): Promise<AgentCapability[]> {
    const values: AgentCapability[] = [];
    for (const adapter of this.adapters.values()) {
      const capability = await adapter.discover();
      this.capabilities.set(adapter.provider, capability);
      values.push(capability);
    }
    return values;
  }

  public listTasks(): TaskEnvelope[] {
    return [...this.tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public getTask(taskId: string): TaskEnvelope | undefined {
    return this.tasks.get(taskId);
  }

  public getApprovals(): ApprovalRequest[] {
    return [...this.approvals.values()];
  }

  public async events(taskId?: string): Promise<TaskEvent[]> {
    return this.ledger.list(taskId);
  }

  public async createTask(input: CreateTaskInput): Promise<TaskEnvelope> {
    if (input.idempotencyKey) {
      const inFlight = this.createInFlight.get(input.idempotencyKey);
      if (inFlight) return inFlight;
      const operation = this.createTaskInternal(input);
      this.createInFlight.set(input.idempotencyKey, operation);
      try {
        return await operation;
      } finally {
        if (this.createInFlight.get(input.idempotencyKey) === operation) this.createInFlight.delete(input.idempotencyKey);
      }
    }
    return this.createTaskInternal(input);
  }

  private async createTaskInternal(input: CreateTaskInput): Promise<TaskEnvelope> {
    if (input.idempotencyKey) {
      const prior = this.createIdempotency.get(input.idempotencyKey);
      if (prior) return prior;
    }
    if (!input.title.trim() || !input.goal.trim()) throw new Error("Task title and goal are required.");
    if (input.linkedConversationId === "") throw new Error("Conversation id must be omitted or non-empty.");
    if (!input.workspacePath && input.contextFiles?.length) throw new Error("contextFiles require an explicit workspacePath.");
    const now = new Date().toISOString();
    const workspacePath = input.workspacePath ? path.resolve(input.workspacePath) : undefined;
    const contextFiles = (input.contextFiles ?? []).map((file) => {
      const resolved = path.resolve(workspacePath ?? process.cwd(), file);
      if (workspacePath) {
        const relative = path.relative(workspacePath, resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Context file is outside the assigned workspace: ${file}`);
        return relative;
      }
      return resolved;
    });
    const task: TaskEnvelope = {
      id: createTaskId(),
      title: input.title.trim(),
      goal: input.goal.trim(),
      originProvider: input.originProvider,
      workspacePath,
      contextFiles,
      linkedConversationId: input.linkedConversationId,
      privacy: input.privacy ?? "private",
      status: "created",
      revision: 0,
      delegationDepth: 0,
      participants: [],
      budget: normalizeBudget(input.budget),
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    await this.commit(task, "task.created", input.originProvider, 0, { task }, input.idempotencyKey);
    if (input.idempotencyKey) this.createIdempotency.set(input.idempotencyKey, task);
    return task;
  }

  public async delegate(input: DelegateTaskInput): Promise<TaskEvent> {
    const prepared = await this.withTaskLock(input.taskId, async () => this.prepareDelegation(input));
    const { task, adapter, event } = prepared;
    if (prepared.replayed) return event;
    let released = false;
    try {
      const result = await adapter.submit(task, input.prompt);
      if (!result.text.trim()) throw new Error(`${result.provider} returned an empty result.`);
      await this.withTaskLock(task.id, async () => {
        const remaining = this.releaseDelegation(task.id);
        released = true;
        if (task.status === "cancelled") return;
        const proposalId = `proposal_${createEventId().slice(4)}`;
        await this.commit(task, "task.proposal", result.provider, task.revision, {
          proposalId,
          anonymizedLabel: `Proposal ${task.participants.length}`,
          content: redactPrompt(result.text),
          provider: result.provider,
          delegationEventId: event.id,
        });
        if (remaining === 0 && task.status === "running") {
          task.status = "completed";
          await this.commit(task, "task.completed", result.provider, task.revision, {
            provider: result.provider,
          });
        }
      });
    } catch (error) {
      await this.withTaskLock(task.id, async () => {
        if (!released) {
          this.releaseDelegation(task.id);
          released = true;
        }
        if (this.tasks.get(task.id)?.status === "cancelled") return;
        task.status = "failed";
        await this.commit(task, "task.failed", input.provider, task.revision, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      throw error;
    }
    return event;
  }

  private async prepareDelegation(input: DelegateTaskInput): Promise<{ task: TaskEnvelope; adapter: AgentAdapter; event: TaskEvent; replayed?: boolean }> {
    const task = this.requireTask(input.taskId);
    task.participants ??= [];
    const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey();
    const prior = this.idempotency.get(idempotencyKey);
    if (prior) {
      const adapter = this.adapters.get(input.provider);
      if (!adapter) throw new Error(`No adapter registered for ${input.provider}.`);
      return { task, adapter, event: prior, replayed: true };
    }
    if (task.revision !== input.expectedRevision) throw new BrokerConflictError(task.revision);
    const requestedDepth = Math.max(1, Math.floor(input.delegationDepth ?? 1));
    if (requestedDepth > 2) throw new Error("Delegation depth limit reached.");
    const adapter = this.adapters.get(input.provider);
    if (!adapter) throw new Error(`No adapter registered for ${input.provider}.`);
    let capability = this.capabilities.get(input.provider);
    if (!capability) {
      capability = await adapter.discover();
      this.capabilities.set(input.provider, capability);
    }
    if (!capability.available) throw new Error(capability.reason ?? `${input.provider} is unavailable.`);
    if (capability.mode === "api" && !task.budget.allowApiSpend && !this.approvedActions.has(`${task.id}:budget-overage`)) {
      throw new Error(`${input.provider} requires an approved API budget; enable allowApiSpend or request budget-overage approval.`);
    }
    if (capability.mode === "api" && task.privacy !== "external-approved" && !this.approvedActions.has(`${task.id}:external-send`)) {
      throw new Error(`${input.provider} requires external-send approval for this task privacy level.`);
    }
    if (!task.participants.includes(input.provider) && task.participants.length >= task.budget.maxParticipants) {
      throw new Error(`Task participant limit reached (${task.budget.maxParticipants}).`);
    }
    task.status = "running";
    task.delegationDepth = Math.max(task.delegationDepth, requestedDepth);
    if (!task.participants.includes(input.provider)) task.participants.push(input.provider);
    if (capability.capabilities.includes("code-write") && task.workspacePath) {
      const baseWorkspacePath = task.baseWorkspacePath ?? task.workspacePath;
      const workRoot = process.env.INTEGRATED_POWER_WORKTREE_ROOT ?? path.join(baseWorkspacePath, ".integrated-power", "worktrees");
      const workspaces = task.isolatedWorkspaces ?? (task.isolatedWorkspaces = []);
      const isolated = await createIsolatedWorkspace(baseWorkspacePath, `${task.id}-${input.provider}-${workspaces.length + 1}`, workRoot);
      task.baseWorkspacePath = baseWorkspacePath;
      task.isolatedWorkspacePath = isolated.root;
      task.workspacePath = isolated.root;
      workspaces.push({ provider: input.provider, root: isolated.root, branch: isolated.branch });
    }
    task.updatedAt = new Date().toISOString();
    const event = await this.commit(task, "task.delegated", input.provider, input.expectedRevision, {
      provider: input.provider,
      delegationDepth: requestedDepth,
      prompt: redactPrompt(input.prompt),
      baseWorkspacePath: task.baseWorkspacePath,
      isolatedWorkspacePath: task.isolatedWorkspacePath,
      isolatedWorkspaces: task.isolatedWorkspaces,
      workspacePath: task.workspacePath,
    }, idempotencyKey);
    this.activeDelegations.set(task.id, (this.activeDelegations.get(task.id) ?? 0) + 1);
    return { task, adapter, event };
  }

  /** Run bounded independent proposals through the same ledger. Providers are
   * called sequentially so every revision is explicit and stale GUI commands
   * cannot overwrite a newer proposal. */
  public async debate(input: import("./protocol").DebateInput): Promise<{ events: TaskEvent[]; proposals: Proposal[] }> {
    const task = this.requireTask(input.taskId);
    if (task.revision !== input.expectedRevision) throw new BrokerConflictError(task.revision);
    const providers = [...new Set(input.providers)].slice(0, Math.min(4, task.budget.maxParticipants));
    if (!providers.length) throw new Error("At least one debate provider is required.");
    const events: TaskEvent[] = [];
    for (const [index, provider] of providers.entries()) {
      const event = await this.delegate({ taskId: task.id, provider, prompt: `${input.prompt}\n\nThis is independent proposal ${index + 1}; do not rely on another provider's answer.`, expectedRevision: task.revision, delegationDepth: 1, idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:${provider}` : undefined });
      events.push(event);
    }
    return { events, proposals: await this.listProposals(task.id) };
  }

  public async listProposals(taskId: string): Promise<Proposal[]> {
    return (await this.events(taskId)).filter((event) => event.type === "task.proposal").map((event) => {
      const payload = event.payload as { proposalId?: string; anonymizedLabel?: string; content?: string; provider?: ProviderId };
      return { id: payload.proposalId ?? `proposal_${event.id.slice(4)}`, taskId, participant: payload.provider ?? event.actor as ProviderId, anonymizedLabel: payload.anonymizedLabel ?? "Proposal", content: payload.content ?? "", createdAt: event.createdAt };
    });
  }

  public async listEvaluations(taskId: string): Promise<Evaluation[]> {
    return (await this.events(taskId)).filter((event) => event.type === "task.evaluation").map((event) => event.payload as Evaluation);
  }

  public async listEvidence(taskId: string): Promise<Evidence[]> {
    return (await this.events(taskId)).filter((event) => event.type === "task.evidence").map((event) => event.payload as Evidence);
  }

  public async listSyntheses(taskId: string): Promise<Synthesis[]> {
    return (await this.events(taskId)).filter((event) => event.type === "task.synthesis").map((event) => event.payload as Synthesis);
  }

  public async recordEvaluation(input: EvaluationInput): Promise<TaskEvent<Evaluation>> {
    return this.withTaskLock(input.taskId, async () => {
      const task = this.requireTask(input.taskId);
      const key = input.idempotencyKey ?? createIdempotencyKey();
      const prior = this.idempotency.get(key);
      if (prior) return prior as TaskEvent<Evaluation>;
      if (task.revision !== input.expectedRevision) throw new BrokerConflictError(task.revision);
      const proposal = (await this.listProposals(task.id)).find((item) => item.id === input.proposalId);
      if (!proposal) throw new Error(`Proposal not found: ${input.proposalId}`);
      const evaluation: Evaluation = { id: `evaluation_${createEventId().slice(4)}`, taskId: task.id, evaluator: input.evaluator, proposalId: proposal.id, score: Math.max(0, Math.min(1, input.score)), rationale: redactPrompt(input.rationale), createdAt: new Date().toISOString() };
      return this.commit(task, "task.evaluation", input.evaluator, input.expectedRevision, evaluation, key);
    });
  }

  public async recordEvidence(input: EvidenceInput): Promise<TaskEvent<Evidence>> {
    return this.withTaskLock(input.taskId, async () => {
      const task = this.requireTask(input.taskId);
      const key = input.idempotencyKey ?? createIdempotencyKey();
      const prior = this.idempotency.get(key);
      if (prior) return prior as TaskEvent<Evidence>;
      if (task.revision !== input.expectedRevision) throw new BrokerConflictError(task.revision);
      const evidence: Evidence = { id: `evidence_${createEventId().slice(4)}`, taskId: task.id, kind: input.kind, label: input.label.trim(), passed: input.passed, details: redactPrompt(input.details), createdAt: new Date().toISOString() };
      return this.commit(task, "task.evidence", "broker", input.expectedRevision, evidence, key);
    });
  }

  public async synthesize(input: SynthesisInput): Promise<TaskEvent<Synthesis>> {
    return this.withTaskLock(input.taskId, async () => {
      const task = this.requireTask(input.taskId);
      const key = input.idempotencyKey ?? createIdempotencyKey();
      const prior = this.idempotency.get(key);
      if (prior) return prior as TaskEvent<Synthesis>;
      if (task.revision !== input.expectedRevision) throw new BrokerConflictError(task.revision);
      const synthesis: Synthesis = { id: `synthesis_${createEventId().slice(4)}`, taskId: task.id, provider: input.provider, content: redactPrompt(input.content), dissent: (input.dissent ?? []).map(redactPrompt), confidence: Math.max(0, Math.min(1, input.confidence)), evidenceIds: input.evidenceIds ?? [], createdAt: new Date().toISOString() };
      return this.commit(task, "task.synthesis", input.provider, input.expectedRevision, synthesis, key);
    });
  }

  public async requestApproval(
    taskId: string,
    action: ApprovalRequest["action"],
    description: string,
    requestedBy: ApprovalRequest["requestedBy"],
    expectedRevision?: number,
    idempotencyKey?: string,
  ): Promise<ApprovalRequest> {
    return this.withTaskLock(taskId, async () => {
      const task = this.requireTask(taskId);
      const key = idempotencyKey ?? createIdempotencyKey();
      const prior = this.approvalIdempotency.get(key);
      if (prior) return prior;
      const revision = expectedRevision ?? task.revision;
      if (task.revision !== revision) throw new BrokerConflictError(task.revision);
      const approval: ApprovalRequest = {
        id: `approval_${createEventId().slice(4)}`,
        taskId,
        action,
        description,
        requestedBy,
        expectedRevision: revision,
        createdAt: new Date().toISOString(),
      };
      this.approvals.set(approval.id, approval);
      this.approvalIdempotency.set(key, approval);
      task.status = "awaiting_approval";
      await this.commit(task, "task.approval_requested", requestedBy, revision, approval, key);
      return approval;
    });
  }

  public async approve(approvalId: string, expectedRevision?: number, idempotencyKey?: string): Promise<void> {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error("Approval request not found.");
    await this.withTaskLock(approval.taskId, async () => {
      if (idempotencyKey && this.idempotency.has(idempotencyKey)) return;
      const current = this.approvals.get(approvalId);
      if (!current) throw new Error("Approval request not found.");
      const task = this.requireTask(current.taskId);
      const revision = expectedRevision ?? task.revision;
      if (task.revision !== revision) throw new BrokerConflictError(task.revision);
      task.status = "running";
      this.approvals.delete(approvalId);
      this.approvedActions.add(`${task.id}:${current.action}`);
      await this.commit(task, "task.approved", "user", revision, current, idempotencyKey);
    });
  }

  public async mergeTask(taskId: string, expectedRevision: number, idempotencyKey?: string): Promise<string> {
    if (idempotencyKey && this.mergeResults.has(idempotencyKey)) return this.mergeResults.get(idempotencyKey)!;
    const operation = this.mergeQueue.then(() => this.performMerge(taskId, expectedRevision, idempotencyKey));
    this.mergeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async performMerge(taskId: string, expectedRevision: number, idempotencyKey?: string): Promise<string> {
    return this.withTaskLock(taskId, async () => {
      const task = this.requireTask(taskId);
      if (task.revision !== expectedRevision) throw new BrokerConflictError(task.revision);
      if (!this.approvedActions.has(`${taskId}:merge`)) throw new Error("Merge requires an approved merge request.");
      if (!task.baseWorkspacePath || !task.isolatedWorkspacePath) throw new Error("Task has no isolated workspace to merge.");
      const workspaces = task.isolatedWorkspaces?.length
        ? task.isolatedWorkspaces
        : [{ provider: task.originProvider, root: task.isolatedWorkspacePath, branch: `integrated-power/${task.id.replace(/[^A-Za-z0-9._-]/g, "-")}` }];
      const commits: string[] = [];
      for (const workspace of workspaces) {
        let result: { commit: string };
        try {
          result = await mergeIsolatedWorkspace({ root: workspace.root, branch: workspace.branch, basePath: task.baseWorkspacePath });
        } catch (error) {
          await abortBaseMerge(task.baseWorkspacePath);
          task.status = "awaiting_approval";
          await this.commit(task, "task.conflict", "broker", task.revision, { branch: workspace.branch, error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
        commits.push(result.commit);
        await removeIsolatedWorkspace({ root: workspace.root, branch: workspace.branch, basePath: task.baseWorkspacePath }).catch(() => undefined);
      }
      task.status = "completed";
      task.workspacePath = task.baseWorkspacePath;
      task.isolatedWorkspacePath = undefined;
      task.isolatedWorkspaces = [];
      const commit = commits[commits.length - 1];
      await this.commit(task, "task.merged", "user", expectedRevision, { commit, commits, branches: workspaces.map((item) => item.branch), clearWorkspaces: true }, idempotencyKey);
      if (idempotencyKey) this.mergeResults.set(idempotencyKey, commit);
      return commit;
    });
  }

  public async cancel(taskId: string, expectedRevision: number, idempotencyKey?: string): Promise<void> {
    await this.withTaskLock(taskId, async () => {
      if (idempotencyKey && this.idempotency.has(idempotencyKey)) return;
      const task = this.requireTask(taskId);
      if (task.revision !== expectedRevision) throw new BrokerConflictError(task.revision);
      task.status = "cancelled";
      await this.commit(task, "task.cancelled", "user", expectedRevision, {}, idempotencyKey);
    });
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.cancel(taskId).catch(() => undefined)));
  }

  public chooseRoute(taskId: string): ReturnType<typeof chooseProvider> {
    const task = this.requireTask(taskId);
    return chooseProvider({ task, capabilities: [...this.capabilities.values()] });
  }

  private async commit<T>(
    task: TaskEnvelope,
    type: TaskEvent["type"],
    actor: TaskEvent["actor"],
    expectedRevision: number,
    payload: T,
    idempotencyKey = createIdempotencyKey(),
  ): Promise<TaskEvent<T>> {
    const currentRevision = task.revision;
    if (expectedRevision !== currentRevision) throw new BrokerConflictError(currentRevision);
    const event: TaskEvent<T> = {
      id: createEventId(),
      taskId: task.id,
      type,
      actor,
      expectedRevision,
      revision: currentRevision + 1,
      idempotencyKey,
      createdAt: new Date().toISOString(),
      payload,
    };
    await this.ledger.append(event);
    this.idempotency.set(idempotencyKey, event);
    task.revision = event.revision;
    task.updatedAt = event.createdAt;
    return event;
  }

  private replay(event: TaskEvent): void {
    if (event.type === "task.created") {
      const payload = event.payload as { task?: TaskEnvelope };
      if (payload.task) {
        this.tasks.set(event.taskId, { ...payload.task, participants: payload.task.participants ?? [] });
        this.createIdempotency.set(event.idempotencyKey, this.tasks.get(event.taskId)!);
      }
    }
    const task = this.tasks.get(event.taskId);
    if (task) {
      task.participants ??= [];
      task.revision = Math.max(task.revision, event.revision);
      task.updatedAt = event.createdAt;
      if (event.type === "task.delegated") {
        task.status = "running";
        const payload = event.payload as { delegationDepth?: number; baseWorkspacePath?: string; isolatedWorkspacePath?: string; isolatedWorkspaces?: TaskEnvelope["isolatedWorkspaces"]; workspacePath?: string };
        task.delegationDepth = Math.max(task.delegationDepth, payload.delegationDepth ?? 1);
        if (payload.baseWorkspacePath) task.baseWorkspacePath = payload.baseWorkspacePath;
        if (payload.isolatedWorkspacePath) task.isolatedWorkspacePath = payload.isolatedWorkspacePath;
        if (payload.isolatedWorkspaces) task.isolatedWorkspaces = payload.isolatedWorkspaces;
        if (payload.workspacePath) task.workspacePath = payload.workspacePath;
        const provider = event.actor;
        if (provider !== "broker" && provider !== "user" && !task.participants.includes(provider)) task.participants.push(provider);
      }
      if (event.type === "task.approval_requested") {
        task.status = "awaiting_approval";
        const approval = event.payload as ApprovalRequest;
        if (approval?.id) {
          this.approvals.set(approval.id, approval);
          this.approvalIdempotency.set(event.idempotencyKey, approval);
        }
      }
      if (event.type === "task.approved") {
        task.status = "running";
        const approval = event.payload as ApprovalRequest;
        if (approval?.id) this.approvals.delete(approval.id);
        if (approval?.action) this.approvedActions.add(`${event.taskId}:${approval.action}`);
      }
      if (event.type === "task.completed") task.status = "completed";
      if (event.type === "task.failed") task.status = "failed";
      if (event.type === "task.cancelled") task.status = "cancelled";
      if (event.type === "task.conflict") task.status = "awaiting_approval";
      if (event.type === "task.merged") {
        task.status = "completed";
        const payload = event.payload as { clearWorkspaces?: boolean };
        if (payload?.clearWorkspaces) {
          task.workspacePath = task.baseWorkspacePath;
          task.isolatedWorkspacePath = undefined;
          task.isolatedWorkspaces = [];
        }
      }
    }
    this.idempotency.set(event.idempotencyKey, event);
  }

  private async withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskLocks.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    this.taskLocks.set(taskId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.taskLocks.get(taskId) === queued) this.taskLocks.delete(taskId);
    }
  }

  private releaseDelegation(taskId: string): number {
    const remaining = (this.activeDelegations.get(taskId) ?? 1) - 1;
    if (remaining > 0) this.activeDelegations.set(taskId, remaining);
    else this.activeDelegations.delete(taskId);
    return Math.max(0, remaining);
  }

  private requireTask(taskId: string): TaskEnvelope {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }
}

function redactPrompt(value: string): string {
  return value
    .replace(/(api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|token|password|secret)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9]{12,}\b/g, "sk-[redacted]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[private-key redacted]");
}
