import { AgentCapability, BudgetPolicy, ProviderId, TaskEnvelope } from "./protocol";

export interface RoutingContext {
  task: TaskEnvelope;
  capabilities: AgentCapability[];
  localSuccessByProvider?: Record<string, number>;
}

export interface RouteDecision {
  provider: ProviderId;
  score: number;
  reason: string[];
}

const defaultBudget: BudgetPolicy = {
  maxParticipants: 4,
  allowApiSpend: false,
};

export function normalizeBudget(input?: Partial<BudgetPolicy>): BudgetPolicy {
  const maxParticipants = Math.min(
    4,
    Math.max(1, Math.floor(input?.maxParticipants ?? defaultBudget.maxParticipants)),
  );
  return {
    maxParticipants,
    maxUsd: input?.maxUsd,
    maxTokens: input?.maxTokens,
    allowApiSpend: input?.allowApiSpend === true,
  };
}

export function chooseProvider(context: RoutingContext): RouteDecision | undefined {
  const candidates = context.capabilities.filter((item) => item.available);
  if (!candidates.length) return undefined;
  const scored = candidates.map((capability) => {
    let score = 0;
    const reasons: string[] = [];
    if (capability.capabilities.includes("executor")) { score += 30; reasons.push("executor"); }
    if (capability.capabilities.includes("streaming")) { score += 10; reasons.push("streaming"); }
    if (capability.capabilities.includes("code-write") && context.task.workspacePath) {
      score += 20; reasons.push("workspace-capable");
    }
    if (capability.mode === "local") { score += 10; reasons.push("local-first"); }
    if (capability.provider.startsWith("xai.")) score -= 100;
    const success = context.localSuccessByProvider?.[capability.provider];
    if (typeof success === "number") {
      score += Math.max(-10, Math.min(20, success * 20));
      reasons.push("local-history");
    }
    if (!context.task.budget.allowApiSpend && capability.mode === "api") {
      score -= 1000;
      reasons.push("api-spend-disabled");
    }
    return { provider: capability.provider, score, reason: reasons };
  });
  scored.sort((left, right) => right.score - left.score);
  const best = scored[0];
  return best ? { provider: best.provider, score: best.score, reason: best.reason } : undefined;
}

export function shouldEscalate(
  task: TaskEnvelope,
  evidence: Array<{ passed: boolean }>,
  confidence?: number,
): boolean {
  if (task.budget.maxParticipants <= 1) return false;
  if (evidence.some((item) => !item.passed)) return true;
  return typeof confidence === "number" && confidence < 0.7;
}

