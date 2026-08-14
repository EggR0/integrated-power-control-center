# Artifact Contract

## Goal

Keep one user-visible Integrated Orchestrator artifact per logical Antigravity
IDE task. Antigravity IDE indexes ordinary files below
`~/.gemini/antigravity-ide/brain/<conversation-id>/`, including `scratch/`, so a
prompt, response, or helper file created there becomes another artifact card.

## Required policy

- Treat one Antigravity `brain/<conversation-id>` directory as one logical task
  unless the user explicitly starts a separate deliverable.
- Reuse `<brain-session>/ip-orchestrator.md` for all visible orchestration
  results in that task. Replace it for a latest-state artifact or append a
  section when the reasoning history matters.
- Reuse one `-TaskKey` for the logical task. Do not derive a new key from every
  prompt, step, model, timestamp, or subtask title.
- Pass short generated instructions with `-PromptText`. Pass existing source
  inputs with `-ContextFile`. Do not create `prompt_*.txt`, `response_*.txt`,
  `run_*.ps1`, or model-named files in `brain/scratch` merely to call a model.
- Put implementation scripts and generated project data in the target
  workspace. Let the bundled scripts keep metrics and machine logs under the
  configured Integrated Power state root.
- Do not delete or rewrite older brain artifacts automatically. This policy
  prevents new proliferation; cleanup of existing user files is a separate,
  explicit operation.

## Script behavior

`Invoke-LocalLLM.ps1`, `Invoke-vLLMJob.ps1`, and `Invoke-CodexJob.ps1` use
`-ArtifactPolicy Coalesce` by default. If an output path points anywhere inside
an Antigravity brain session, the actual output is redirected to that session's
single `ip-orchestrator.md` file. Use `-ArtifactPolicy Separate` only when the
user explicitly asks for another visible artifact.

When `-OutputFile` is omitted, the scripts use a stable
`reports/tasks/<task-key>.md` path instead of a timestamped filename.
`Invoke-LocalLLM.ps1` and `Invoke-vLLMJob.ps1` accept
`-ArtifactWriteMode Replace|Append`; `Replace` is the default and preserves the
latest response shape.

Example:

```powershell
& $invokeLocal `
  -PromptText "Review the selected workspace files and list the three risks." `
  -ContextFile @($fileA, $fileB) `
  -TaskKey "current-antigravity-task" `
  -TaskTitle "Risk review" `
  -OutputFile (Join-Path $brainSession "ip-orchestrator.md") `
  -ArtifactWriteMode Append
```
