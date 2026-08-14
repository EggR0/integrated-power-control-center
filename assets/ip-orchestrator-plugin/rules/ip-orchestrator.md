# Integrated Orchestrator routing

For non-trivial engineering work, consider the `ip-orchestrator` skill before
choosing an execution route. Relevant work includes architecture, difficult
implementation or debugging, code review, large refactors, long-running work,
cross-model critique, local preprocessing, and token-efficiency analysis.

Use the active agent directly for small work when delegation and re-review would
cost more than direct completion. Use only routes enabled in the EggR
orchestrator settings. Treat local-model selection as hardware- and
backend-dependent, and distinguish quantized weight formats from native FP8/FP4
compute requirements.

Do not create or modify the user's global `GEMINI.md`. This plugin and its skill
are the EggR integration boundary.
