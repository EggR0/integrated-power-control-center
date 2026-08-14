# Integrated Power 독립 관제 센터

Tauri 2 기반의 로컬 관제 화면입니다. 대화 내용을 자체 UI로 복제하지 않고, loopback 브로커의 작업·에이전트 능력·승인 상태만 표시합니다.

## 실행

VSIX가 실행 중이 아닌 개발 모드에서는 `npm run broker`로 동일한 브로커를 loopback에 시작한 뒤 관제 화면을 엽니다. Tauri 패키지는 관제 UI, 브로커, MCP 서버, 현재 플랫폼의 Node 런타임을 함께 포함하므로 확장 설치에 의존하지 않습니다.

Claude Desktop은 `integrations/claude/claude_desktop_config.example.json`의 공식 MCP stdio 설정을 사용합니다. ChatGPT Desktop은 공식 MCP loopback 연결이 제공되는 경우에만 `/mcp`를 사용하며, 연결할 수 없는 환경에서는 자동화하지 않습니다.

작업 원장 키는 Windows Credential Manager/macOS Keychain/Linux Secret Service를 우선 사용하고, Windows에서는 사용자 범위 DPAPI를 fallback으로 사용합니다.

독립 Tauri 패키지는 현재 Node 런타임과 SQLCipher 네이티브 백엔드를 함께 번들합니다. 따라서 설치본의 `events.enc.jsonl`은 평문 JSONL이 아니라 암호화된 SQLite 원장으로 생성됩니다. 네이티브 모듈을 사용할 수 없는 VSIX·개발 환경에서는 호환성을 위해 암호화 JSONL fallback이 자동 선택됩니다.

번들 런타임은 Windows 실행 규칙을 만족하는 `node-runtime.exe`라는 고정 이름을 사용하며, 브로커는 loopback(`127.0.0.1`)에만 바인딩합니다. GUI 자격증명 추출이나 일반 대화 수집은 수행하지 않습니다.

## 개발 및 패키징

`npm install` 후 `npm run tauri:dev` 또는 `npm run tauri:build`를 실행합니다. 크로스플랫폼 패키지는 `.github/workflows/control-center.yml`의 Windows·macOS·Linux matrix에서 생성합니다.
The broker also accepts standard A2A v1 HTTP+JSON `POST /message:send` requests. Configured remote peers are discovered through the official `@a2a-js/sdk` client; set `INTEGRATED_POWER_A2A_ENDPOINTS` to a JSON array of peer base URLs. Loopback peers are treated as local, while remote peers remain budget-gated.
MCP agents can create, delegate, review, and request approval, but the approval action itself is intentionally exposed only through the user-facing control center HTTP/UI path. This prevents a prompt-injected model from approving its own merge or external transfer.

If the installed Codex desktop package cannot be launched as a child process on
Windows, set `INTEGRATED_POWER_CODEX_EXE` to a separately installed, callable
Codex CLI. The capability endpoint reports the detected path and launch reason
instead of claiming that App Server execution is ready.

ChatGPT custom MCP is an inbound host connection and requires a user-approved
HTTPS Secure MCP Tunnel URL. The loopback `/mcp` endpoint is not advertised as
a direct ChatGPT endpoint; it is reserved for local MCP clients such as Claude
Desktop. The broker never creates a tunnel, extracts GUI credentials, or drives
the ChatGPT window.

After `npm run tauri:build`, run `npm run verify:package` to check the bundled
runtime files, platform installer artifact, and Unix executable permission.
