---
name: ip-orchestrator
description: Routes non-trivial AI engineering work between the active agent, Codex, and hardware-compatible local LLMs while recording route, quality, elapsed time, and token evidence. Use for architecture, code review, complex implementation, large refactors, cross-model critique, long-running delegation, local preprocessing, VRAM-aware model selection, token-efficiency analysis, or explicit Integrated Power, ip-orchestrator, and orchestration requests.
---

# AI Work Router

This is the primary routing skill for token-efficient AI work. When a task may benefit from delegation, classify the work first and choose one of three routes:

For the first-wave Integrated Power path, read `references/broker.md` and use
`scripts/Invoke-IntegratedPowerBroker.ps1`. Prefer `local.openai-compatible`
for low-risk preprocessing and `google.antigravity.ide` for workspace-aware
implementation. Do not bypass the broker by importing an unlinked conversation.

Before choosing a route, resolve the settings path with the bundled settings
module; do not assume another user's home path. Read `references/paths.md` for
any install, migration, Knowledge, state, or cross-PC path operation. Never
select a route that is absent from `EnabledRoutes`. Use
`DefaultRoute` only when task evidence does not favor another enabled route.
When the active surface is Antigravity IDE, read `references/artifacts.md`
before creating a prompt, response, helper script, or delegated output. Reuse
one visible artifact and one task key for the current logical task.
`LocalLlm.Endpoint` and `LocalLlm.Model` are non-secret defaults; API key values
must come from the named environment variable and must never be written to this
settings file. `LocalLlm.HardwarePolicy.Mode=user_default` means the named model
has priority, but the selector must still report a VRAM/backend warning before
running an incompatible model. `Mode=auto` means the selector must inspect the
current machine at execution time; never reuse a GPU snapshot from another PC.

- **Main Agent Direct**: small edits, local inspection, glue work, or tasks where calling another model would cost more than it saves.
- **Codex**: hard implementation, architectural review, code review, test generation, refactors, or work that needs strong coding judgment.
- **Local LLM / vLLM**: offline preprocessing, broad summarization, noisy-context reduction, draft checklists, clustering, extraction, or other low-risk transformations where local tokens are preferable.

Do not require the user to explicitly name Codex or local LLM. If the task is large, ambiguous, repetitive, or token-sensitive, choose the route that best preserves cloud quota while still producing a reliable artifact.

Default to local-first delegation when the local machine is healthy. Codex and Antigravity should be treated as high-value resources for implementation, difficult debugging, architectural judgment, final review, and deciding how to delegate work. If weekly cloud quota reset is close, lower the threshold for useful high-quality cloud work, but keep local LLM as the default for low-risk preprocessing.

## Mode Classification (Routing)

Always read the detailed contract in the `references/` directory before executing a mode.

0. **Routing Decision**:
   - **Trigger**: Any non-trivial task where delegation, token conservation, or local preprocessing may help.
   - **Action**: Decide Main Agent Direct vs Codex vs Local LLM before spending large cloud context.
   - **Contract**: Read `references/routing.md`.

1. **Debate Mode (`scripts/Invoke-CodexDebate.ps1`)**:
   - **Trigger**: Architecture decisions, ADRs, tradeoff reviews, second opinions, read-only critique.
   - **Action**: Generates a persistent human-readable Markdown transcript.
   - **Contract**: Read `references/debate.md`.

2. **Job Mode (`scripts/Invoke-CodexJob.ps1`)**:
   - **Trigger**: Bounded implementation, massive refactoring, automated test generation, or tasks that need to overwrite/create files directly without an ongoing conversation.
   - **Action**: Executes the prompt and saves the result directly, skipping human chat loops.
   - **Contract**: Read `references/job.md`.

3. **WorkWindow Mode (`scripts/Invoke-AiWorkWindow.ps1`)**:
   - **Trigger**: Longer supervised coding sessions, processing the `ai-work-queue.md`, iterative execution across multiple tasks, or high-level context coordination.
   - **Action**: Aggregates the local queue, calendar, and context into a single mega-prompt for Codex.
   - **Contract**: Read `references/workwindow.md`.

4. **Local LLM Mode (`scripts/Select-LocalLLMModel.ps1`, then `scripts/Invoke-LocalLLM.ps1` or `scripts/Invoke-vLLMJob.ps1`)**:
   - **Trigger**: Summarization, preprocessing, extraction, local draft generation, broad context compression, or explicit local LLM/vLLM requests.
   - **Action**: Selects the best local model using the user's policy, installed-model size, current free VRAM, GPU compute capability, backend support, registry priors, and measured success/time metrics; then sends the prompt to Ollama or an OpenAI-compatible local endpoint.
   - **Consent boundary**: Treat selection and installation as separate operations. If the selector returns `NeedsUserConfirmation=true`, explain its `SuggestedInstalls` to the user and ask whether to install one. Never run `ollama pull` until the user explicitly approves the named model.
   - **Contract**: Read `references/local-llm.md`.

5. **Integrated Power Broker Mode (`scripts/Invoke-IntegratedPowerBroker.ps1`)**:
   - **Trigger**: Explicit Agy/local delegation, shared task state, concurrent GUI control, or a need to preserve revisions and approvals.
   - **Action**: Create or link a task, delegate through the loopback broker, and read the encrypted event-backed result.
   - **Contract**: Read `references/broker.md`.

6. **Durable Knowledge Routing**:
   - **Trigger**: A result, decision, incident, procedure, or worklog entry must survive the current task or be reused by another agent or PC.
   - **Action**: Resolve the user-owned Knowledge root, reuse an existing Obsidian note when possible, and select only a declared route. Never classify knowledge by inventing a Git branch.
   - **Contract**: Read `references/knowledge.md`.

## Execution Timer and Metrics Guidelines

When you dispatch a task to Codex using one of the background scripts above, the scripts will run their own native **Watchdog Loop** using `System.Diagnostics.Process` to enforce safe execution and pure UTF-8 logging.

Follow these explicit rules:
1. **Required Completion Sentinel**: You MUST explicitly tell Codex in your prompt: "When you are completely finished with all work, output exactly the phrase `CODEX_JOB_DONE status=success` at the very end of your response."
2. **Estimate Before Start**: Before dispatch, record a token range, a point estimate, and confidence. Treat this as an estimate, never as provider-reported usage.
3. **Wait for Completion**: Use the `schedule` tool to set a long wait timer. You do NOT need to poll. The script's watchdog will automatically kill Codex if it gets stuck *after* outputting the sentinel (`completed_stuck`), or if it completely idles for 10 minutes (`idle_timeout`).
4. **Execution Time and Token Feedback Loop**:
   - When the background script completes, observe the actual elapsed time.
   - Retrieve usage from the provider response or JSON log when available. Label the evidence as `provider_reported`, `calculated`, `estimated`, or `unavailable`; never silently substitute an estimate for actual usage.
   - Store metrics below the Integrated Power workspace state `reports/` directory. The bundled path module resolves it without a repository marker file.
   - Compare the pre-start point estimate with provider-reported actual usage. Calibrate by provider, model, task class, route, and agent surface; do not claim an improvement unless the task also passed its quality checks.
   - Report a percentage only when both the numerator and a documented capacity/budget denominator are known.
   - Follow the repository's `docs/reference/eggr-telemetry.ko.md` and `config/eggr.telemetry.schema.json` when they are present.
   - Use `scripts/Write-EggRTelemetryEvent.ps1` for metadata-only start, usage, waiting, completion, failure, and cancellation events.

## General Rules

- For Codex, pass source paths through `-ContextFile` and let Codex read them with its sandbox. For a local LLM, use the invoke script's `-ContextFile` so the script composes context without a separate prompt artifact.
- Ensure you select the appropriate `-Sandbox` permissions (`read-only`, `workspace-write`, `danger-full-access`).
- Prefer local LLM preprocessing before sending broad noisy context to Codex.
- Never call a local LLM model arbitrarily; use the selector first unless the user explicitly names an exact model and accepts bypassing measured routing.
- Do not describe a successful direct `Invoke-LocalLLM.ps1 -Model ...` call as successful automatic model selection. The selector only makes and explains a routing decision; the invoke script performs inference with the selected or explicitly named model.
- Do not use a short standalone warm-up request as a readiness gate. The Ollama invoke script detects loaded models and gives the real generation request a longer cold-load timeout while setting `keep_alive` on that request.
- Do not confuse a weight format such as Q4/MXFP4 with native FP4 tensor
  arithmetic. Use quantization to estimate model memory. Treat FP8/FP4 compute
  capability as a hard filter only when the selected backend/model actually
  requires that native dtype.
- If local LLM is offline, fall back to Main Agent Direct or Codex only after noting the fallback in the artifact.
- If Codex Debate fails or is inconclusive, fall back to a narrower Main Agent Direct step or a bounded Codex Job rather than repeating broad debate prompts.
- Produce at most one durable, user-visible artifact per logical task by default. Metrics and machine logs are state, not additional user artifacts; transient prompts and raw responses must not become separate Antigravity brain files.
- Record why the chosen route is token-efficient, especially when skipping local preprocessing.
- Treat user-owned Knowledge `main` as the canonical global store. Code
  repositories still use isolated task branches; do not transfer that branch
  policy to Knowledge.

## Codex Installation & Executable Resolution

This plugin automatically resolves the path to the Codex executable. By default, it checks:
1. System `PATH`.
2. `$env:CODEX_EXE`
3. Local AppData installations (`%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`)
4. Interactive console prompt if not found.

If a user complains that Codex isn't running, advise them to either add Codex to their PATH, set the `CODEX_EXE` environment variable, or run the command directly to be prompted for the path.
