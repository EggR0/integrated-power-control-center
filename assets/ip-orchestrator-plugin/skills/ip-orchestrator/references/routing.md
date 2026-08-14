# Routing Contract

## Purpose
Choose the lowest-cost reliable execution route before spending large cloud context.

## Default Policy

Use `config/ai_routing_policy.json` when it exists. The default stance is **local-first**:

- If the computer, GPU, and local endpoint are healthy, prefer local LLM for most delegatable summarization, extraction, Korean/text preprocessing, long-context compression, and low-risk planning.
- Keep Codex and Antigravity for high-performance implementation, difficult debugging, architectural judgment, final review, and work delegation decisions.
- When weekly cloud quota reset is near, lower the threshold for useful Codex/Antigravity work so expiring quota is not wasted.
- Keep the decision to two layers: first ask whether local LLM can do it reliably; if not, decide whether cloud quality is worth spending now.

## Decision Order

1. **Main Agent Direct**
   - Use for small, obvious edits; short explanations; local file inspection; command checks; packaging; verification; and glue work.
   - Prefer this when the task can be completed quickly with local tools and does not need a second model.

2. **Local LLM / vLLM**
   - Use for broad summarization, preprocessing, extraction, deduplication, clustering, noisy-context reduction, draft checklists, and other low-risk transformations.
   - Prefer this before Codex when the input is large, the task is low-risk, or the output can be verified locally.
   - This is the default delegated route unless the task clearly needs high-end coding judgment or the local machine is unhealthy.
   - First select the model with workspace `scripts/dispatch/Select-LocalLLMModel.ps1` or the bundled `scripts/Select-LocalLLMModel.ps1`.
   - Then use workspace `scripts/dispatch/Invoke-LocalLLM.ps1` for Ollama or `scripts/dispatch/Invoke-vLLMJob.ps1` for an OpenAI-compatible vLLM endpoint; use bundled scripts only as fallback.

3. **Codex Debate**
   - Use for architecture decisions, ambiguous structural changes, tradeoff review, second opinions, and read-only critique.
   - Prefer this when the routing decision itself needs high-quality judgment or when local LLM output is likely too weak to trust.
   - Use `scripts/Invoke-CodexDebate.ps1`.

4. **Codex Job**
   - Use for bounded implementation, difficult code review, test generation, refactors, or direct edits that need strong coding judgment.
   - Prefer this over local LLM for direct repository edits with real correctness risk.
   - Use `scripts/Invoke-CodexJob.ps1`.

5. **Work Window**
   - Use when the task is a supervised queue/calendar/context dispatch that may choose among multiple pending tasks.
   - Use `scripts/Invoke-AiWorkWindow.ps1`.

## Required Behavior

- Do not wait for the user to name a backend if the task clearly benefits from delegation.
- If the user explicitly names Codex or local LLM, honor that choice unless it is unavailable or unsafe.
- If local LLM is unavailable, note that fact and choose Main Agent Direct or Codex based on risk.
- If local LLM is available, do not pick a model by name from memory. Use the selector so task type, initial benchmark priors, local success rate, elapsed time, and installed-model availability are considered.
- If Codex Debate fails, times out, or returns an inconclusive result, fall back to Main Agent Direct for a narrow next step or ask Codex Job only when the implementation boundary is clear.
- If Codex quota should be conserved, use local LLM for preprocessing where practical.
- Keep file contents out of prompts when paths are sufficient.
- Leave one reusable artifact under Integrated Power workspace state `reports/` or `discussions/`, or summarize the direct local change. On Antigravity IDE, follow `artifacts.md` and reuse the session's `ip-orchestrator.md`; do not expose prompts, responses, and helper scripts as separate artifacts.
- Record the chosen route and reason in the artifact whenever delegation is used. Include why cheaper local preprocessing was or was not used.

## Token Efficiency Checks

- Before Codex: ask whether local LLM can reduce, summarize, classify, or extract the context first.
- Before Local LLM: ask whether a simple local command or direct inspection would be cheaper and more reliable; if not, run the model selector and record the selection reason.
- Before Main Agent Direct: ask whether the task is large enough that a preprocessing artifact would prevent repeated cloud context spending.
- Prefer reusable artifacts over repeated model calls.
