# WorkWindow Mode Contract

**Script**: `scripts/Invoke-AiWorkWindow.ps1`

## Purpose
Context aggregation and iterative execution across multiple tasks. Used when the AI needs to pull from a global task queue (`ai-work-queue.md`), calendar schedules, and current operational context.

## Usage
- Use `-UseCalendar` if you need to sync and attach calendar events.
- Use `-RunCodex` to actually send the aggregated mega-prompt to Codex (otherwise it just generates the prompt).
- Set `-Sandbox` appropriately.

## Output
- Aggregates the local queue, calendar, and context.
- Dispatches the prompt to Codex via `Invoke-CodexJob.ps1` internally.
- Results are saved in Integrated Power workspace state `reports/window-dispatch-result-<stamp>.md`.
