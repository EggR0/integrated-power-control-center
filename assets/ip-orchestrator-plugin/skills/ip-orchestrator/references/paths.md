# Portable Path Contract

경로를 사용하는 작업 전에 이 계약을 적용한다. 다른 사용자나 다른 PC의 절대 경로를
재사용하거나 사용자 홈 전체를 검색해 비슷한 폴더를 추측하지 않는다.

## 우선순위

1. 현재 명령의 명시적 경로 인자
2. `INTEGRATED_POWER_*` 환경 변수
3. 현재 PC의 canonical `roots.json`
4. 현재 OS와 현재 사용자로 계산한 제품 기본값
5. 이전 `eggr` 설정은 새 설정이 없을 때만 마이그레이션 입력으로 읽는다.

canonical roots 파일은 기본적으로
`%USERPROFILE%\.config\integrated-power\roots.json`이다.
`INTEGRATED_POWER_ROOTS_CONFIG`가 있으면 그 파일을 사용한다. 이 파일은 PC별 로컬
설정이며 Knowledge Git에 커밋하지 않는다.

지원하는 명시적 환경 변수:

- `INTEGRATED_POWER_WORK_ROOT`
- `INTEGRATED_POWER_KNOWLEDGE_ROOT`
- `INTEGRATED_POWER_STATE_ROOT`
- `INTEGRATED_POWER_TOOLS_ROOT`
- `INTEGRATED_POWER_ANTIGRAVITY_PLUGIN_ROOT`
- `INTEGRATED_POWER_ORCHESTRATOR_SETTINGS`
- `INTEGRATED_POWER_LOCAL_LLM_REGISTRY`

## 에이전트 규칙

- PowerShell에서는 함께 배포된 `eggr-roots.ps1` 또는 `EggR.Paths.psm1`을 호출한다.
- 확장에서는 `storagePath.ts`의 resolver를 사용한다. 별도의 홈·Documents·AppData
  조합 로직을 새로 만들지 않는다.
- 기본값은 제안값이다. 최초 설치에서 Configuration Center에 표시하고 사용자가
  저장 또는 설치 버튼을 눌러 확정하게 한다.
- 사용자가 Knowledge를 WorkRoot 밖에 선택하면 그 위치를 존중하고 경고만 남긴다.
- 설정 경로가 없거나 유효하지 않으면 다른 드라이브나 사용자 폴더를 검색하지 말고
  Configuration Center에서 다시 선택하도록 안내한다.
- 경로 이동은 별도 작업이다. 설정 변경만으로 기존 폴더를 이동·병합·삭제하지 않는다.

## 새 PC 인수인계

새 PC는 공개 확장과 사용자의 Knowledge Git만 가져온다. 이전 PC의 `roots.json`을
그대로 복사하지 않는다. Configuration Center에서 공통 작업 루트, Knowledge 경로,
Antigravity 플러그인 루트를 현재 PC 기준으로 확정한 뒤 Knowledge remote를 연결한다.
Git에는 지식과 작업 기록을 저장하고, 로컬 설치 절대 경로는 저장하지 않는다.
