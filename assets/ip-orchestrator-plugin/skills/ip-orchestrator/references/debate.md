# Debate Mode Contract

**Script**: `scripts/Invoke-CodexDebate.ps1`

## Purpose
Initiate durable Architecture Decision Record (ADR) debates when an architectural decision needs a persistent human transcript, machine event log, and raw execution logs.

## Usage
- Start a durable ADR debate using only supported script inputs (`-Topic`, `-PromptFile` / `-ExtraPrompt`, `-ContextFile`).
- Pass paths, not contents. Do not paste source code into prompts.
- In the Codex prompt, explicitly tell Codex that `-ContextFile` values are file paths and that Codex must read the files itself using its sandbox permissions.

## Output
- Human-readable transcript: a markdown file under the Integrated Power workspace state `discussions/` directory.
- System logs and prepared prompts: under the Integrated Power workspace state `sessions/<run-id>/` directory.
