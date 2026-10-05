# 하네스 변경 이력

(CLAUDE.md 에서 옮김, 2026-10-06)

| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-09-30 | 초기 구성 — 에이전트 3(opencode-prober·litecode-dev·boundary-qa) + 스킬 4 + vitest·playwright 실물 테스트 스택 | 전체 | 사용자 요청: 테스트 필수, 실물 테스트 포함 |
| 2026-09-30 | 첫 실행(llm.ts 결함 3건) 후 실측 반영 — 캐시 비격리의 대가 명시, 401 판독 행 추가 | skills/live-test, skills/opencode-probe | QA 지적(사용자 models.json 갱신), 외부 provider 유출 실측 |
| 2026-09-30 | 화면 디자인은 deepseek-harness `packages/client/ui-*` 를 주 참조처로 — 화면↔패키지 대응표, 시안과의 우선순위 | agents/litecode-dev, agents/boundary-qa, skills/litecode-build, skills/opencode-probe | 사용자 지시 |
| 2026-09-30 | "지우는 것도 자기가 만든 것만" 규칙 — 임시 폴더는 기록한 경로만 삭제 | agents/boundary-qa, agents/litecode-dev, skills/live-test | QA 가 추측으로 리더 데모의 임시 폴더를 지움 |
| 2026-09-30 | 한 라운드에는 사용자 요청만 — QA 참고는 따로 모아 보고 | skills/litecode-build | 사용자 "너무 오래 걸린다" |
| 2026-09-30 | QA 는 `차단` 재현 스크립트를 `_workspace/qa-repro/` 에 남긴다 | agents/boundary-qa | 프로브를 지워 구현자가 재현 못 함 |
| 2026-09-30 | 테스트 창을 화면에 띄우지 않는다 (`LITECODE_TEST_HIDDEN=1`) — 에이전트·스크립트도 따른다 | skills/live-test | 사용자 "테스트 중 다른 일을 못 하겠다" |
| 2026-10-01 | 엔진 경계 = `ctx.llm` + `ctx.engine` (문서 정정), bootstrap 의 IPC·종료를 Cordis effect·fiber dispose 로 | agents/litecode-dev, electron/main.ts | 코디스 사용 검토 |
| 2026-10-01 | 병렬 라운드 규칙 — 동시 2개·worktree·기능별 컴포넌트/실물 테스트 파일·실물 테스트 잠금·리더가 합침 | skills/litecode-build | 사용자 "병렬 개발은 안 되나" |
| 2026-10-02 | 돌고 있는 라운드에 범위를 얹지 않는다(다음 라운드로), 개발 중엔 자기 실물 파일만·전체는 착지 직전 한 번 | skills/litecode-build | 사용자 "왜 이리 오래 걸리지" |
| 2026-10-02 | GitHub 흐름 — 라운드마다 이슈 → 브랜치 → PR → main 머지(머지는 사용자 확인). 원격 kim-taehan/litecode | skills/litecode-build | 사용자 지시 |
| 2026-10-02 | main 머지는 리더가 직접 검증(typecheck·단위·실물 전체 초록)한 뒤 묻지 않고 한다 | skills/litecode-build | 사용자 "머지까지 알아서 해" |
| 2026-10-02 | 채팅을 opencode 레거시 경로로 — "신규 세대만 쓴다" 원칙 폐기, 프로토콜 절에 레거시 묶음 | CLAUDE.md | 사용자 결정 (MCP·task) |
| 2026-10-03 | 실물 테스트를 과정에서 뺀다 — 새로 안 쓰고 안 돌린다, 머지 기준은 typecheck·단위 | skills/litecode-build, agents/litecode-dev, CLAUDE.md | 사용자 "실물 테스트를 빼자" (전체 한 번 8~9분, 머지마다) |
| 2026-10-02 | 디자인 이야기는 전부 HTML 시안(Artifact 캔버스)으로 — 구현자에겐 "시안: <링크>" | skills/litecode-build, agents/litecode-dev | 사용자 "모든 디자인은 html 시안으로 말한다" |
| 2026-10-02 | 실물 테스트 전체는 리더만 머지 전에 — 구현자는 자기 실물 파일만 | skills/litecode-build, agents/litecode-dev | 사용자 "실물 테스트는 니가 하는걸로 하자" (에이전트 50분대, 전체를 두 번 돌림) |
