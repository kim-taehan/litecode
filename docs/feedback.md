# 사용자 피드백

데스크탑 사용 중 보고한 문제와 불편함. 기록 + 코드 조사만 한다 — 수정은 안 한다. 뒤에 몰아서 다룬다.

## 형식
- `## YYYY-MM-DD #N — 짧은 제목` 부터 시작
- `- Where: ` 어떤 화면/어떤 동작에서 (사용자가 말한 그대로)
- `- What: ` 사용자 원문 (거의 그대로 옮긴다)
- `- Expect: ` 기대했던 동작 (사용자가 명시한 경우)
- `- Status: ` open

## 2026-10-13 #1 — 프로젝트 전환 팝업 위치

- Where: 사이드바 위쪽 프로젝트 전환(현재 프로젝트 카드)이 여는 팝업 (스크린샷 첨부 — 프로젝트 목록 + "폴더 열기⋯")
- What: "저 팝업 위치를 변경하려고 해"
- Expect: 왼쪽 사이드바(탭) 완전 옆으로 — 팝업을 사이드바 우측 가장자리 바로 옆으로 이동
- Status: done (2026-10-13)
- Fix: 2026-10-13 — `ProjectQuickOpen` 이 전환 버튼 rect 로 좌표(우측 8px·같은 높이)를 인라인으로 주도록 하고, CSS `.project-open__panel--anchored` 가 `transform: none` + 폭 클램프. 버튼이 없으면 상단 중앙 CSS 폴백.

### 조사
- 위치: `renderer/styles.css:225-231` — 팝업 위치를 통째로 정하는 CSS(`position: fixed; top: 84px; left: 50%; transform: translateX(-50%)`)
  - 관련: `renderer/ProjectQuickOpen.tsx:108`(패널 마크업) · `renderer/App.tsx:589,741`(`.app` 루트 하단 렌더) · `renderer/Sidebar.tsx:135`(트리거 카드 `.project-switch`)
- 메커니즘: 앵커(프로젝트 카드) 기준이 아니라 뷰포트 기준 고정 위치. 수평은 `left: 50%` + `translateX(-50%)` 로 창 정중앙, 수직은 `top: 84px`. JS 좌표 계산 없음(`switchRef` 는 바깥 클릭 감지용). → 사이드바 카드 위치와 무관하게 항상 창 상단 중앙에 뜬다. `docs/status.md:58`(#305, 2026-10-12): 원래 "팝오버"였는데 "상단 중앙 패널"로 바뀐 것이 본고.
- 판정: 코드에서 확인됨

## 2026-10-13 #2 — 설치본 앱과 dev 앱 포트 겹침

- Where: 설치된 앱(패키지)과 `npm run dev` 인스턴스를 동시에 실행할 때
- What: "지금 설치된 앱이랑 npm run dev 로 호출한 앱이랑 포트가 겹쳐서"
- Expect: "개발용 포트는 다른걸로 가고 싶고 아니면 동일한 포트 사용중일때 그거 피해서 할 수 있을까?" — dev 는 별도 포트, 또는 점유 중이면 다른 포트로 피하기
- Status: done (2026-10-13)
- Fix: 2026-10-13 — #332: dev 실행기(`scripts/dev.mjs`)가 5174 부터 빈 포트를 찾아 vite 를 그 포트(strictPort)로 띄우고 실제 URL 을 electron 에 준다. remote(http·TLS) 운반은 고정 포트(47600)가 다른 인스턴스에 점유되면 EADDRINUSE 로 다음 포트까지(8회) 피해 듣고, 상태·QR 이 실제 포트를 싣는다.

### 조사
- 위치:
  - `src/services/engine.ts:542-548` — 엔진(opencode) 포트: `freePort()`(127.0.0.1:0 으로 OS 임시 포트 회수), 고정값·env 없음. 기동: `engine.ts:437,455`
  - `src/services/keyProxy.ts:93` · `src/services/appMcp.ts:70` — key 프록시·앱 MCP: `listen(0)` OS 임시 포트
  - `src/services/remote/limits.ts:4` — 고정 포트 **47600**(`REMOTE_DEFAULT_PORT`, 앱이 듣는 고정 포트 중 유일). `remote/http.ts:91`·`remote/https.ts:45,109` 사용, `remote` 기능 **기본 꺼짐**(`shared/features.ts:48`)
  - `vite.config.ts:10-12` — dev 전용: vite 서버 **5174 고정**(`strictPort: true`); 설치본은 `file://` 렌더러라 안 씀
  - `electron/main.ts:84-87` — **단일 인스턴스 락**(userData 당 1개). dev·설치본 앱 이름 다 `litecode` → userData 동일(`electron/main.ts:110`, `--user-data-dir` 미사용)
  - `electron/main.ts:160` — 8080 은 provider 기본 baseURL(나가는 주소)이라 듣는 포트 아님
- 메커니즘: 엔진·프록시·MCP 는 실행마다 OS 임시 포트라 고정 충돌은 설계상 없음(잔여 리스크는 freePort close → opencode rebind 경합 창, 재시도·대체 포트 없음). 인스턴스 두 개가 동시에 있을 때 부딪힐 수 있는 고정 포트는 47600(remote 켬 전제)뿐 — EADDRINUSE 발생 시 기록만 하고 재시도·대체 없음. 그런데 동일 userData + 단일 인스턴스 락이라 기본 설정상 "설치본+dev 동시 구동" 자체가 막혀 있음 → 보고된 겹침은 비기본 실행(`--user-data-dir` 로 둘 다 띄웠거나, 5174 vite 충돌의 오독 등) 전제.
- 판정: 의심됨(코드상으로는, 실물 확인 필요) — 포트 구조는 확인됐지만, 현상 재현에는 실물 상태 확인 필요(둘 다 프로세스 살아있나, remote/l 켜져 있나, 5174 에러였나)

## 2026-10-13 #3 — ⌘+↑/↓ 세션 이동 + 현재 세션 표기 강화

- Where: 사이드바 대화(세션) 목록 (스크린샷 첨부 — 제목 + 경과 뱃지 "now"·"31min")
- What: "command 위 아래 화살표로 세션 이동하고 싶어" + "현재 세션에 대해서 더 확실하게 표기 하고 싶어"
- Expect: ⌘(Ctrl) + ↑/↓ 로 바로 이전/다음 대화로 건너뛰기(사이드바 목록 순서 기준) · 현재 세션은 **행 강조 + "현재" 라벨 뱃지**
- Status: done (2026-10-13)
- Fix: 2026-10-13 — #330(PR #331): `useSessionNav`(⌘↑/↓ = 이전/다음 대화, 목록 순서·끝에서 감) + 현재 행 `--fill-active` 바탕 + 시간 자리에 "현재" 뱃지(`sidebar.current`). 화살표를 비워주려면 터미널 탭 단축키는 ⌘T(새 터미널)·⌘[·⌘](이전/다음)으로 바꾸는 WIP 도 같이 끝.

## 2026-10-13 #5 — 선택된 대화 행을 더 확실하게

- Where: 사이드바 대화 목록 — (#3 의 현재 표기 위에 추가 요청)
- What: "근데 지금 선택된 대화 조금더 잘보이게 할 수 있을까??"
- Expect: 선택 행 바탕을 `--accent-soft`(연한 블루) + 제목 반볼드 (사용자 결정: "블루 선택")
- Status: done (2026-10-13)
- Fix: 2026-10-13 — #334(PR #335): `.session-item--active` 바탕 `--fill-active` → `--accent-soft` + 제목 500. 같은 날 dev → main sync(PR #336).

## 2026-10-13 #4 — (통합됨)

- Note: #3 에 통합 — 같은 영역(사이드바 세션 목록 이동·표기)이라 issue 도 하나
- Status: dropped (2026-10-13)

### 조사
- 위치:
  - 행: `renderer/Sidebar.tsx:178-295` (행 래퍼 .182-185, 여는 버튼 `.209-212` — 클릭 시 `setActiveIds`)
  - 현재 세션 상태: `renderer/App.tsx:68` `activeIds`(프로젝트→대화 id 맵) + `:158` 파생 `active`
  - 기존 현재 표기: `Sidebar.tsx:184` `session-item--active` → `styles.css:590` `background: var(--fill-hover)` — **호버와 완전 같은 약한 바탕**, 굵기·경계 없음. 더 짙은 토큰 `--fill-active`(`styles.css:16`) 존재하나 세션 행에 미사용
  - 전역 키 컨벤션: Mac=meta(!ctrl) / else=ctrl(!meta), alt 무시, `aria-modal` 이면 물러남, input·textarea·contenteditable 포커스에서 제외(컴포저 예외), preventDefault+stopPropagation, xterm 이기기 위해 캡처 fase·최신값 ref 로
  - **⌘↑/↓ 세션 이동 바인딩: 렌더러에 없음** (방향키 핸들은 드롭다운·콤포저뿐)
- 메커니즘: (A) 대화 교체 경로는 행 버튼의 `setActiveIds` 하나뿐 — 이동 구현은 `active` → 목록 index → 인접 요소로 교체. (B) 행 시각 요소: 상태 점 `notice-dot` · 제목 marquee · 고정 pin · 시간 뱃지 `now`/`5m`… · fresh·위임 마크.
- 판정: 코드에서 확인됨 — 단, 작업트리에 터미널 단축키 WIP(⌘↓/⌘↑ 해제)가 미커밋으로 있어 ⌘↑/↓ 를 비워주는 전제 — 사용자 결정으로 세션 이동 브랜치에 같이 종료

## 2026-10-13 #6 — LLM 대화로 훅 생성 기대

- Where: 훅 관리 다이얼로그 (새 훅 화면 — 이벤트·매치·명령·기한·범위 수동 입력)
- What: "보통 llm 에게 훅은 만들어달라고 시키지 않아?"
- Expect: "[훅 추가] 폼 빼버릴려고" — 추가 엔트리는 LLM 대화(`litecode_create` kind=hook)로만 (사용자 결정 2026-10-13, #7과 같은 issue)
- Status: done (2026-10-13)
- Fix: 2026-10-13 — #339: `HooksPopup` 의 [훅 추가] 버튼·`HookEditor` 신규 카드 제거(편집·삭제는 그대로), 인트로 는 설명 한 줄만

### 조사
- 위치:
  - UI: `renderer/PlusMenu.tsx:165-179`("훅" 줄 + `HooksPopup` 열기) · `renderer/HooksPopup.tsx:100-102`([훅 추가] 버튼) · `:145-365`(`HookEditor` 폼) — `:184` `window.litecode.saveHook`
  - 저장: `shared/ipc.ts:172,422`(`hooks:save`) → `src/services/hooks/bridge.ts:23` → `src/services/hooks.ts:269-275`(`saveHook` → `checkHookDraft`+`change`) — 파일 저장: `electron/main.ts:745-751` `userData/hooks.json` + `hooks-projects.json`, 형식 `src/services/hooks/config.ts:16-23`
  - **제이전트 도구: 존재** — `shared/make.ts:9-14`(`litecode` MCP + 도구 `create`, `MakeKind='skill'|'mcp_server'|'hook'`) → `src/services/appMcp/tools/make.ts:110-144`(스키마) · `:100-108`(`addHook` = **UI와 같은 `ctx.hooks.saveHook()`**) · `electron/main.ts:726` 플러그인 등록
  - 게이트: `src/services/engineConfig.ts:167-173` — 기본/전체 권한·매번 묻기 = `ask`, 계획 모드·하위 작업 = 도구 자체 없음(`deny`) · 기능 게이트 `shared/features.ts:9,14,39`
  - 승인 카드: `renderer/makeView.ts:58-95`(훅 카드 :90-91) · `renderer/Attention.tsx:72-81`(허용 시 scope 실어 답) · `renderer/Make.tsx:69-85`(카드 내용)
- 메커니즘: 훅은 UI 전용이 아님 — 모델이 `litecode_create(kind:'hook', …)` 를 부르면 UI 팝업과 **같은 `saveHook`·같은 `userData/*.json`** 에 저장됨. 다만: ① 계획 모드·하위 작업엔 도구 자체가 없음, ② 전체 권한에서도 매번 승인 카드를 물음(자동 승인 사용자 결정), ③ 카드를 데스크탑 화면(내용 확인)에서만 허용해야 저장됨.
- 판정: 코드에서 확인됨 — 사용자의 직관("LLM 에게 시키면 된다")은 코드상 성립. "수동 입력만 되는 듯" 보이는 이유는 위 제약(모드별 도구 유무 + 승인 카드) 때문으로 보이며, 실물에서 "시켜도 카드가 안 뜬다"는 현상이라면 별도 확인 필요

## 2026-10-13 #7 — MCP 연결은 보통 mcp.json 수정 · LLM 대화 요청

- Where: 입력창 `+` 메뉴 > MCP 서버 팝업 — 로컬 서버 추가 폼 (이름·종류·명령·인자·환경 변수를 화면에 직접 입력)
- What: "보통 mcp 연결할떄 이렇게 안하지 않나?" → "mcp.json 을 고치거나 llm 대화로 요청하잖아"
- Expect: "그래서 내가 하고 싶은 이야기는 아까 팝업에서 구지 서버추가 hook 추가 는 빼버릴려고" — MCP 팝업의 [+ 서버 추가]와 훅 팝업의 [훅 추가] 폼 제거, 추가는 LLM 대화(·mcp.json) 경로로만 + "우리 skill, mcp, hook 등을 만드는 도구 따로 제공하지 않아" — 생성 전용 폼(팝업)은 빼되, 기존 `litecode_create` 도구는 그대로 둔다 (사용자 결정 2026-10-13)
- Status: done (2026-10-13)
- Fix: 2026-10-13 — #339: `McpPopup` 의 [+ 서버 추가] 둘 · `ServerEditor` 신규 카드 제거(편집·삭제는 그대로), 추가 = LLM 대화 `litecode_create` · 프로젝트 `.mcp.json`

### 조사
- 위치:
  - (a) 파일 수정: `src/services/mcp.ts:720-727`(`projectServers` — `.mcp.json`→`opencode.json(c)`→`.opencode/opencode.json(c)` 겹쳐 읽기) → 매 턴 `prepare`(:428)→`attach`(:458, :464-466)→`ctx.llm.mcpAdd`(:488) = `POST /mcp?directory=`(`src/services/llm/service.ts:613-627`)로 그 폴더 인스턴스에 자동 붙음. 개인 설정 `~/.config/opencode`(`personalServers` :729-736)은 opencode 가 스스로 띄우고 앱은 보여 주기만(끄기/켜기 = disconnect/connect :498-507)
  - (b) LLM 대화: `litecode_create` kind=`mcp_server`(이슈 #145) — `shared/make.ts:10-15`·`src/services/appMcp/tools/make.ts:88-98`(`addMcpServer`): project+비밀 없으면 `ctx.mcp.addToProjectFile`(`mcp.ts:358-373`)이 **프로젝트 `.mcp.json` 을 실제로 고쳐 씀**, 아니면 `ctx.mcp.save`(팝업 폼과 같은 메서드, :297-341)로 앱 저장소. 승인 3겹(엔진 ask·하위 작업 제외·앱 카드 `renderer/Make.tsx` 저장 위치 선택)
  - 폼의 절대 경로 안내: `renderer/McpPopup.tsx:440`(`mcp.hint`) — `shared/i18n/ko.ts:688`(폐쇄망이라 npx 대신 미리 설치한 바이너리). 설계 근거: `_workspace/00_next_mcp.md`(프로젝트 자동 실행 = 사용자 결정)·`mcp.ts:18-54` 머리 주석
  - 테스트: `tests/unit/mcp.test.ts:146-159,185-192,274-302,453-470` · `tests/unit/makeTools.test.ts:251-356`(`.mcp.json` 에 Claude Code 모양 쓰기·비밀→앱 안) · 실물 `tests/live/mcp.live.test.ts:17`
- 메커니즘: 엔진의 `opencode.json` 에 mcp 블록이 없어, 세 길(폼·파일·대화) 모두 매 턴 `prepare → mcpAdd` 로 그 폴더 인스턴스에 런타임으로만 붙음(디스크 불리·엔진 재기동 시 다음 턴에 재붙임). 대화 경로는 `toFile` 일 때 (a) 의 `.mcp.json` 수정을 대리 — 즉 폼은 세 출처 중 "앱 저장소" 만 다루는 GUI일 뿐 독점 경로가 아님.
- 판정: 코드에서 확인됨 — 사용자가 기대한 두 경로(파일 수정·LLM 대화) 모두 실제로 존재·동작(유닛+실물 테스트 존재). 팝업 폼은 그중 하나일 뿐
