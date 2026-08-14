# Durable Knowledge Contract

Use this contract only for durable user-owned knowledge, not ordinary source
code or generated runtime state.

1. Resolve the Knowledge root from Integrated Power roots configuration.
2. Read `<Knowledge>/.ai/knowledge-routing.json`.
3. Search existing Markdown by document id, aliases, normalized title, and file
   name before proposing a new file.
4. Update an existing note when the subject already exists.
5. Otherwise select one declared route:
   - `00 Inbox`: classification is uncertain or temporary.
   - `10 Projects`: work has an end condition.
   - `20 Knowledge`: reusable method, fact, decision pattern, or lesson.
   - `30 Areas`: ongoing responsibility or operations.
   - `90 Templates`: reusable document form.
6. Never create an undeclared top-level folder. When uncertain, use Inbox.
7. On Windows, prefer
   `%LOCALAPPDATA%\IntegratedPower\bin\route-knowledge.cmd` to validate the
   path.
8. Save only explicit routed files with `save-knowledge`; use
   `save-agent-worklog` for the central audit line.
9. Knowledge `main` is canonical. Do not create `agent/...` branches to
   represent topics or tasks. Stop and report any existing non-main branch
   instead of creating another branch or force-pushing.
10. Never store secrets, credentials, raw private prompts, large model files,
    datasets, build output, or unrelated repository contents in Knowledge.
