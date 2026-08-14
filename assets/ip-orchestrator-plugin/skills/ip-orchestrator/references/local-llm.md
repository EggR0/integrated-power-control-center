# Local LLM Mode Contract

**Workspace selector**: `scripts/dispatch/Select-LocalLLMModel.ps1`
**Workspace Ollama script**: `scripts/dispatch/Invoke-LocalLLM.ps1`
**Workspace vLLM script**: `scripts/dispatch/Invoke-vLLMJob.ps1`
**Bundled fallback scripts**: this skill's `scripts/` directory contains the same helper scripts for workspaces that do not vendor them.

## Purpose
Use a measured local model for token-efficient preprocessing, summarization, extraction, and low-risk draft generation.

## Use When

- The task involves large or noisy text that should be compressed before Codex sees it.
- The user explicitly asks for local LLM, vLLM, offline model, or local preprocessing.
- The expected output is a report, summary, checklist, classification, or extracted data that can be verified locally.
- Cloud quota should be conserved.

## Avoid When

- The task requires direct code edits with high correctness risk.
- The local endpoint is offline and the user needs a finished implementation now.
- The task involves sensitive credentials or deployment actions.

## Model Selection Rule

Do not call an arbitrary local model. Before a local LLM call, select a model with:

```powershell
.\scripts\dispatch\Select-LocalLLMModel.ps1 -TaskType extraction -InstalledOnly -AsJson
```

Use the selected model and pass the selector reason into the invocation with `-SelectedBy selector -SelectionReason "<reason>"`. The selector reads:

- `config/local_llm_model_registry.csv` for web-seeded prior scores by task type.
- `reports/local_llm_metrics.csv` for local measured success rate, elapsed time, and tokens/second.
- Ollama `/api/tags` to prefer models that are actually installed when `-InstalledOnly` is used.

Model selection does not download or run a model. Inspect the complete JSON result
before invoking anything:

- When `NeedsUserConfirmation=false`, invoke `SelectedModel` and preserve its
  `SelectionBasis` and `Reason` in the metrics arguments.
- When `NeedsUserConfirmation=true`, show the user the models and reasons in
  `SuggestedInstalls` and ask which, if any, may be installed. Do not run
  `ollama pull` before the user explicitly approves the exact model name.
- If the user declines installation, rerun selection using installed models or
  choose Main Agent Direct/Codex. Do not silently download a registry model.
- A direct `Invoke-LocalLLM.ps1 -Model <name>` call performs inference only. It
  is not evidence that automatic selection or registry synchronization worked.

It also reads `LocalLlm.HardwarePolicy` from Integrated Power settings and detects NVIDIA
VRAM/compute capability with `nvidia-smi`. `Quantization` describes stored
weights and is only a memory-estimation input. GGUF Q4 and MXFP4 do not by
themselves require native FP4 execution. Compute capability is a hard constraint
only when a registry row explicitly declares `MinimumComputeCapability`, or
declares `RequiredRuntimePrecision` with a supported `PrecisionBackend`.
Built-in FP4/FP8 thresholds are scoped to `tensorrt-rtx`; other runtimes must
declare their own tested minimum.

For reproducible offline diagnosis:

```powershell
.\scripts\dispatch\Select-LocalLLMModel.ps1 `
  -Provider ollama -AvailableVramGB 21 -ComputeCapability 8.6 `
  -DisableHardwareDetection -AsJson
```

An unregistered `user_default` model remains selectable with
`Compatibility=unknown_user_default` unless `-InstalledOnly` is requested or an
explicit hard hardware constraint is violated. Automatic mode stays registry-
and provider-scoped.

Valid `-TaskType` values are `summarization`, `extraction`, `coding`, `reasoning`, `korean`, `long_context`, `routing_review`, and `general`.

## Usage

- For Ollama, use workspace `scripts/dispatch/Invoke-LocalLLM.ps1` when present; otherwise use bundled `scripts/Invoke-LocalLLM.ps1`.
- For OpenAI-compatible vLLM, use workspace `scripts/dispatch/Invoke-vLLMJob.ps1` when present; otherwise use bundled `scripts/Invoke-vLLMJob.ps1`.
- Prefer `-PromptText` for generated instructions and `-ContextFile` for existing inputs. Use `-PromptFile` only for an existing reusable workspace file; do not create a per-call prompt below Antigravity `brain/`.
- Reuse one `-TaskKey` for the logical task. The default output is the stable `reports/tasks/<task-key>.md`, not a timestamped file.
- On Antigravity IDE, pass the session's stable `ip-orchestrator.md` as `-OutputFile`. The default `Coalesce` policy also redirects any path below that brain session to this one file.
- Pass `-TaskType`, `-SuccessRegex`, and `-MinOutputChars` when the output has a verifiable shape.
- For Ollama, `-KeepAlive` defaults to `30m` and is sent in the actual
  `/api/generate` request. `-TimeoutSeconds` defaults to 900 seconds for an
  already-loaded model; `-ColdLoadTimeoutSeconds` defaults to 1800 seconds when
  `/api/ps` reports that the model is not loaded or its state cannot be checked.
  `-ConnectTimeoutSeconds` defaults to 10 seconds. Override these values for the
  model and storage speed when needed.
- Do not require a separate 30-second warm-up to succeed. Cold loading and
  generation occur in the same real request under the cold-load timeout. A
  failed optional warm-up is a warning, not proof that inference cannot work.
- For vLLM, optionally pass `-Endpoint`; bare URLs are normalized to `/v1`. Use `VLLM_BASE_URL` and `VLLM_API_KEY` when needed.

Example after an approved selector result:

```powershell
.\scripts\dispatch\Invoke-LocalLLM.ps1 `
  -PromptText "Review the supplied context and return a concise risk list." `
  -ContextFile @($fileA, $fileB) `
  -TaskKey "current-task" `
  -Model gemma4:26b `
  -SelectedBy selector `
  -SelectionReason "<selector Reason>" `
  -KeepAlive "30m" `
  -TimeoutSeconds 900 `
  -ColdLoadTimeoutSeconds 1800
```

## Output

- The final local LLM response is written to `-OutputFile` or the stable `reports/tasks/<task-key>.md` path. `-ArtifactWriteMode Append` adds a timestamped section to the same file; `Replace` recomposes the latest result.
- Token metrics are appended to Integrated Power workspace state `reports/token_usage.csv` when available.
- Task metrics are appended to Integrated Power workspace state `reports/local_llm_metrics.csv`.
- The task metrics CSV records `TaskType`, `Success`, `ActualElapsedSeconds`, `OutputChars`, `TokensPerSecond`, `SelectedBy`, `SelectionReason`, and `ErrorMessage`.
- `SuccessRegex` is only an automatic shape check. If semantic review finds the output wrong, relabel the row with `scripts/metrics/Update-LocalLLMMetric.ps1` in this workspace or the bundled `scripts/Update-LocalLLMMetric.ps1` so future routing uses real success data instead of superficial keyword matches.

## Fallback

If the local endpoint is offline, record that in the artifact and choose either Main Agent Direct or Codex depending on the task's risk and complexity.
