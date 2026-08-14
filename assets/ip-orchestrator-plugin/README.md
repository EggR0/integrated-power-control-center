# Integrated Orchestrator Plugin

Antigravity IDE에서 현재 에이전트 직접 처리, Codex 위임, 하드웨어에 맞는
로컬 LLM 전처리 경로를 선택하는 Integrated Power 플러그인입니다.

## 설치

1. 권장: Antigravity IDE의 `Integrated Power: Open Configuration Center`에서
   Integrated Orchestrator 설정을 저장하고 플러그인을 설치합니다.
2. 기본 수동 설치: 이 폴더를 현재 사용자의
   `~/.gemini/config/plugins/ip-orchestrator-plugin/`에 복사합니다. Antigravity
   profile이 다른 위치에 있으면 Configuration Center에서 plugin root를 먼저
   선택하거나 `INTEGRATED_POWER_ANTIGRAVITY_PLUGIN_ROOT`를 명시합니다.
3. 독립 설정: `install/Install-Plugin.ps1`을 실행합니다.

설정은 기본적으로 `~/.config/integrated-power/orchestrator.json`에 저장됩니다.
`INTEGRATED_POWER_ORCHESTRATOR_SETTINGS` 환경변수로 다른 절대 경로를 지정할 수 있습니다.
이전 `~/.config/eggr/orchestrator.json`과
`~/.gemini/config/codex_plugin_settings.json`은 새 설정이 없을 때만 마이그레이션
입력으로 읽으며 원본을 삭제하지 않습니다.

공통 작업·Knowledge·상태·도구·plugin root의 우선순위는
`skills/ip-orchestrator/references/paths.md`를 따릅니다. 배포 패키지에는 개발자나
다른 사용자의 절대 경로를 넣지 않습니다.

Ollama 경로를 설정하면 `scripts/Sync-OllamaModelRegistry.ps1`이 `/api/tags` 또는
`ollama ls`로 설치 모델을 확인하고
`~/.config/integrated-power/local_llm_model_registry.csv`를 갱신합니다. 설치된 미등록
모델에는 중립 점수를 적용하고, 레지스트리에만 있는 모델은 자동 설치하지 않습니다.
선택기가 `NeedsUserConfirmation=true`를 반환한 경우에만 에이전트가 후보를 설명하고
사용자에게 물어야 하며, 승인 전 `ollama pull`은 금지됩니다.

## Antigravity IDE 아티팩트

Antigravity IDE는 `brain/<작업 ID>` 아래의 일반 파일을 각각 아티팩트로 표시합니다.
플러그인은 기본적으로 같은 작업의 출력을 `ip-orchestrator.md` 하나로 합치며,
`-PromptText`와 `-ContextFile`을 지원해 호출용 prompt/response 파일이 `scratch/`에
늘어나지 않게 합니다. 기존 사용자 파일은 삭제하지 않으며, 명시적으로 서로 다른
결과물이 필요할 때만 `-ArtifactPolicy Separate`를 사용합니다.

## 전역 규칙 경계

이 플러그인은 `~/.gemini/GEMINI.md`를 생성하거나 수정하지 않습니다.
Antigravity IDE는 `plugin.json`과
`skills/ip-orchestrator/SKILL.md`를 플러그인 경로에서 발견합니다. 라우팅
힌트는 플러그인 내부 `rules/`에 포함되므로 사용자의 전역 규칙과 분리됩니다.

## 안전한 갱신

- 새 플러그인은 임시 디렉터리에서 준비한 뒤 원자적으로 교체합니다.
- 기존 `eggr-orchestrator-plugin`과 더 이전의
  `codex-orchestrator-plugin`은 정확한 관리 표식을 확인한 뒤
  `.integrated-power-backups/`에 보존하고 `ip-orchestrator-plugin`을
  설치합니다.
- URL에 API 키나 비밀번호를 넣지 않습니다. 비밀 값은 환경변수를 사용합니다.
- Dashboard 활성화만으로 플러그인이나 설정을 갱신하지 않습니다.
