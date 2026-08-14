# ChatGPT 연결 경계

ChatGPT Desktop에서 공식 MCP 연결 기능이 활성화된 경우 loopback 브로커의 `http://127.0.0.1:37241/mcp`를 연결 대상으로 사용할 수 있습니다. ChatGPT가 loopback에 접근할 수 없는 배포 환경에서는 이 어댑터를 자동 활성화하지 않고 비활성 이유를 표시합니다.

GUI 세션의 쿠키·토큰·대화 기록을 추출하거나 재사용하지 않습니다.
## Current bridge boundary

ChatGPT custom MCP apps are inbound host connections: ChatGPT calls the
Integrated Power MCP tools from its own UI. ChatGPT does not accept a direct
loopback MCP server, so expose the broker only through a user-owned Secure MCP
Tunnel and set `INTEGRATED_POWER_CHATGPT_MCP_URL` to the resulting HTTPS URL.
The broker never creates that tunnel automatically and never drives the
ChatGPT window.

The loopback URL shown in older notes is for local MCP-capable clients such as
Claude Desktop; it is not a supported direct ChatGPT endpoint.
