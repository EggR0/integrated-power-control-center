# Claude Desktop 연결

Claude Desktop의 공식 로컬 MCP 설정에 `claude_desktop_config.example.json`의 `integrated-power` 서버를 추가합니다. 경로는 실제 설치 위치로 바꾸십시오.

이 연결은 Claude의 자격증명이나 기존 대화를 읽지 않습니다. Claude가 명시적으로 호출한 MCP 도구만 작업 원장에 기록됩니다.
## Current bridge boundary

Claude Desktop can use the local MCP configuration in
`claude_desktop_config.example.json`, or a user-approved remote MCP connector.
The broker reads only whether the Integrated Power marker is present in the
configuration; it never reads credentials, cookies, or conversation history.

The Control Center's `Register local MCP` action is user-confirmed, preserves
all other `mcpServers`, and creates a timestamped backup before replacing the
configuration atomically.
