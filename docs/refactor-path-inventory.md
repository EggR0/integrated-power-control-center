# Integrated Power Control Center Path Inventory & Backup Index

## Repository Scope: Standalone Desktop App & Multi-AI Broker (Track 2)

### Core Components & Authorities
- **Tauri 2 Desktop App**:
  - `src-tauri/` (Rust Tauri backend, tauri.conf.json, Cargo.toml, Cargo.lock, icons)
  - `src/` (main.js, style.css)
  - `index.html`
- **Broker Engine & MCP Server**:
  - `src/broker/` (Broker core TypeScript source)
  - `broker-server.js` (Loopback standalone broker launcher)
  - `mcp-server.js` (Standalone stdio MCP launcher)
  - `scripts/copy-broker.js` (Tauri runtime asset bundler)
  - `scripts/smoke-broker.js` (Broker health validation test)
- **Host Integration Templates**:
  - `integrations/chatgpt/` (ChatGPT MCP configuration guide & templates)
  - `integrations/claude/` (Claude Desktop MCP configuration & json template)
- **Local Model Execution Authority**:
  - `assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts/Select-LocalLLMModel.ps1`
  - `assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts/Invoke-LocalLLM.ps1`
  - `assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts/Invoke-vLLMJob.ps1`
  - `assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts/Write-EggRTelemetryEvent.ps1`
  - `assets/ip-orchestrator-plugin/skills/ip-orchestrator/scripts/lib/` (EggR.Paths, EggR.Settings, IntegratedPower.Artifacts)
  - `assets/ip-orchestrator-plugin/skills/ip-orchestrator/references/` (Model registry, routing policies)

### Cleaned / Excluded VSIX-Only Assets
- `assets/knowledge-tools/` (Antigravity IDE Private Git Knowledge onboarding)
- `assets/private-git-knowledge.md` (VSIX setup documentation)
