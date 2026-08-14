# Integrated Power broker bridge

The Integrated Power VSIX starts a loopback-only broker on the local machine.
It is the shared task ledger for Antigravity IDE and local-model delegation.
Use `scripts/Invoke-IntegratedPowerBroker.ps1` instead of reading another GUI's
conversation history or writing directly to an agent's private files.

## First-wave providers

- `google.antigravity.ide`: Agy CLI with `--print`, `--mode accept-edits`, and the selected workspace.
- `local.openai-compatible`: Ollama or another OpenAI-compatible local endpoint.

The broker prefers the D: model server on `127.0.0.1:11435` when `D:\AI_Models`
exists and that endpoint is healthy. The default preferred model is
`qwen3.6:27b`; if it is unavailable, the selector falls back to coding-capable
20B–32B+ models before small fallback models. The bundled
`assets/start-d-local-llm.ps1` script starts that server without changing the
normal Ollama service.

## Safe delegation sequence

1. `-Action health` and `-Action capabilities`.
2. `-Action create` with the user's explicit workspace and privacy policy.
3. `-Action delegate` with the returned task ID and current revision.
4. Read `-Action tasks` or `/v1/tasks/<id>` and keep the revision from the ledger.
5. Request user approval before any merge, publication, external send, or budget overage.

Every delegation must include the current `ExpectedRevision`. A stale command is
rejected instead of overwriting another GUI's work. Unlinked conversations are
not imported, and prompts are redacted for common secret-shaped values before
they are persisted in the encrypted local event ledger.

When a local task has `workspacePath`, the broker automatically attaches a
bounded source snapshot. Both tracked and untracked files are considered;
source files are prioritized, ignored build/dependency directories are skipped,
secrets are redacted, and the default snapshot limit is 12,000 characters.
