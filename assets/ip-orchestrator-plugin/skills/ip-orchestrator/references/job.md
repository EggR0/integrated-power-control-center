# Job Mode Contract

**Script**: `scripts/Invoke-CodexJob.ps1`

## Purpose
Execute a bounded implementation, heavy automated refactoring, or a single intensive task directly without conversational overhead. Used for "Zero-Token Direct Edit Protocol".

## Usage
- Prefer `-PromptText` and pass existing source paths with `-ContextFile`. Use `-PromptFile` only for an existing reusable workspace instruction.
- Reuse a stable `-TaskKey`. Provide the Antigravity session's `ip-orchestrator.md` via `-OutputFile` when a visible artifact is needed.
- Select the appropriate `-Sandbox` (`workspace-write` is usually needed if Codex is meant to directly edit the codebase).

## Output
- The final Codex response is written to `-OutputFile` or the stable Integrated Power state path `reports/tasks/<task-key>.md`.
- Output paths anywhere below Antigravity `brain/<conversation-id>` coalesce to that session's single `ip-orchestrator.md` unless the user explicitly requests `-ArtifactPolicy Separate`.
- Optionally logs usage metrics if `-JsonLog` is provided and the parser script is available.
