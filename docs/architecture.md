# litecode 아키텍처

2026-10-12 기준 코드 전체 분석 (서비스·IPC·렌더러·모바일·패키징).
프로토콜 실측은 `opencode-protocol.md`, 기능별 착지 기록은 `status.md` — 그쪽을 먼저 읽으라.
(같은 날 갱신: remote 분할 #298, jobs strip #295, 프로젝트 빠른 열기 #305, git 승인 흐름 #307)

## 1. 큰 그림

```
┌──────────────────────────── Electron 메인 프로세스 ────────────────────────────┐
│  Cordis Context (1개)  ← 모든 서비스·IPC 핸들러·턴 실행이 여기                 │
│  ├ 설정·프로바이더·프로젝트·세션·트리거 …                                     │
│  ├ chat (턴 소유) ── llm ── engine ──▶ opencode 자식 프로세스 (REST+SSE)      │
│  ├ 키 프록시 HTTP (진짜 Bearer 키는 여기에만)                                 │
│  ├ appMcp MCP 서버 (127.0.0.1 + 매 실행 토큰)                                │
│  └ 리모트 리스너 (Wi-Fi TLS / BLE)                                           │
├─────────────────────────────────────────────────────────────────────────────── │
│  utilityProcess: 음성 인코딩 (sherpa-onnx) — 죽어도 메인 살림                  │
└───────────────────────────────────────────────────────────────────────────────┘
        ▲                    ▲
        │ IPC (invoke+send)  │ HTTP /v1 (REST+SSE, 같은 계약)
┌───────┴────────┐   ┌──────┴────────┐
│ 렌더러 (React) │   │ 모바일 (Android) — "두 번째 화면", 단독 세션 없음        │
│ contextIsolation, nodeIntegration off │
└────────────────┘   └───────────────┘

opencode(1.18.18 고정) ──▶ 사내 LLM 게이트웨이 (LiteLLM 등)   ← 폐쇄망, 바깥 0
```

핵심 결정:

- **엔진은 opencode를 그대로 쓴다.** 에이전트 루프(툴·프롬프트·압축)는 다시 안 짓고, `ctx.llm` 서비스 뒤에 숨겨 엔진 지식은 `llm`+`engine` 두 서비스에만 한정 (교체 시 이 경계만).
- **Cordis 플러그인**이 서비스 뼈대 — `ctx.<key>`로 등록, `inject`로 의존성을 선언하면 그 서비스가 뜰 때까지 자동 대기.
- **모든 로직은 메인.** 렌더러·모바일은 모두 "손님 화면" — `chat.send` 호출과 이벤트를 받는 것만 한다.
- **폐쇄망 원칙**: 런타임 다운로드 0, 바깥 요청 0. 외부 자산은 빌드 시 받아(체크섬 대조) 동봉.

## 2. Cordis 서비스 레이어

### 2.1 기반 서비스 (`electron/main.ts`가 올림)

| ctx 키 | 파일 | inject | 역할 |
|---|---|---|---|
| `settings` | settings.ts | — | 앱 설정 정본 (settings.json), 값 검증·기본값 폴백 |
| `providers` | providers.ts | — | 모델 provider 카탈로그 + safeStorage 봉인된 API 키 |
| `engine` | engine.ts | providers | opencode 1개 수명, 설정 생성, 키 프록시 |
| `llm` | llm/service.ts | providers, engine | opencode 경계 전부 — 턴·구독·승인·기록 |
| `projects` | projects.ts | — | 최근/즐겨찾음 프로젝트(=폴더) 목록, realpath 식별 |
| `sessions` | sessions.ts | llm | 대화 목록 메타(sessions.json) — **내용 정본은 opencode DB** |
| `triggers` | triggers.ts | — | 입력 트리거(`@`/`/`/`!`) 등록소+감지 |
| `chat` | chat.ts | llm, sessions, providers | 대화별 턴 소유 — 보내기·대기열·턴 끝·중지 |
| `attachments` | attachmentsService.ts | chat | 첨부 골라읽기(파일 고르기·드롭·붙여넣기) |
| (플러그인) | autoTitle.ts | llm, sessions, settings | 첫 턴 뒤 `askOnce` 로 제목 |
| `features` | features.ts | settings | 기능 레지스트리 — 묶음 on/off, serial mount/unmount |
| `quit` | quit.ts | chat, settings | 종료 확인(도는 턴·붙은 폰), 창 닫기=숨기기 |
| `report` | report.ts | llm, sessions, … | 대화 내보내기·신고 번들(로컬 저장만) |

### 2.2 기능 묶음 (`features` 레지스트리가 `ctx.plugin`으로 on/off — 꺼지면 통째로 내려감)

| 기능 | ctx 키 | 역할 (의존성) |
|---|---|---|
| `shell` (필수) | — | `!명령` 실행, `shell/data` |
| `skills` (필수) | `skills` | 스킬 목록·본문 붙이기 (llm) |
| `mcp` (필수) | `mcp` | MCP 서버 목록·편집·매 턴 폴더에 붙이기 (llm), `llm/before-turn` 경청 |
| `terminal` | `terminals` | (프로젝트, 번호)별 pty + 출력 축적 (llm) — 다중 터미널 탭 (#303), `terminal/data`(folder, id) |
| `trajectory` | `trajectory` | 레거시 기록 읽기 (llm) |
| `openIn` | `openIn` | 허용 목록 앱으로 폴더/파일 열기 (projects) |
| `appMcp` | `appMcp` | 앱 내장 MCP 서버 — `litecode_*` 도구 (mcp) |
| `goal` | `goal` | 대화별 목표·자동 이어가기 (chat, sessions), `goal/changed` |
| `notifications` | `notifications` | 턴 끝/승인 대기 알림·토스트 (settings, sessions, projects) |
| `remote` | `remote` | 모바일 계약·인증·짝짓기·이벤트 링 (chat, sessions, projects, providers, settings) — `remote/` 디렉터리로 책임별 분할(#298): service(상태·운반·이벤트 링)·routes(REST 표)·pairRequest(pairing)·chatEvents(폰 이벤트)·wire(계약 순수 함수)·types·limits |
| `hooks` | `hooks` | 사용자 셸 훅, 메인에서 실행 (chat, sessions, llm) |
| `voice` | `speech` | 음성 받아쓰기 (settings) |
| `browser` | `browser` | Playwright MCP 엔진에 등록 (mcp) |
| `updates` | `updates` | 새 버전 알림 (settings) |
| `repeatGuard` | `repeatGuard` | 같은 도구 3·5·8번째에 `llm.remind` (llm) |
| `git` | `git` | 시스템 git, 화면+AI 도구 공용 |

기본 켜짐: 필수 3종 + terminal·trajectory·openIn·appMcp. 기본 꺼짐: notifications·remote·web·hooks·voice·browser.

기본이 아닌 서비스(순수 모듈): `history.ts`, `instructions.ts`(AGENTS.md 읽기), `sendQueue.ts`, `keyProxy.ts`/`engineConfig.ts`, `llm/{follow,attention,engineApi,prompt,limits,types}`.

### 2.3 부팅 순서 (electron/main.ts)

`settings → providers → engine → llm → projects → sessions → triggers → bootstrap(inject 8종) → chat+chatBridge → autoTitle → attachments → report → quit → 기능 묶음 등록 → FeaturesService(마지막)`.

- `bootstrap` 플러그인은 inject 8개가 모두 뜬 뒤에 IPC 브리지·진단.
- inject 대기: `static readonly inject` 선언만 하면 cordis가 그 fiber가 마운트된 후 서비스 생성 — 사람이 순서를 안 짜도 됨.
- **함정**: `ctx.plugin(X)` 다음 줄에 `ctx.x` 쓰면 죽는다(비동기 마운트) — inject 선언한 플러그인 안에서만 접근.
- **함정**: 생성자가 던지면 그 서비스 영영 안 뜨고, inject한 쪽이 말없이 기다림 → 파일은 `readJsonFileSync`(모양 다르면 이동+기본값)로만.
- 15초 기한 미달 서비스는 로그+대화상자(resilience.ts `missingServices`).
- `features/changed` → engine이 듣고 재시작(설정 변경은 엔진 재시작으로만 적용).

### 2.4 이벤트 계약

- **엔진의 사실** = `llm/*` (turn-started/ended, attention, tool-started/done, before-turn serial, pre-tool serial) — notifications·hooks·repeatGuard·goal이 경청.
- **화면/모바일이 보는 상태** = `chat/*` (turn-started/progress/attention/ended, interjected, queue-changed, conversations-changed, before-send/after-turn serial) — chat이 브리지로 broadcast.
- `sessions/removed` → chat(큐/턴 abort) + notifications + sweep(llm.deleteSession + purgeDeleted).

## 3. 엔진 (opencode) — `src/services/engine.ts`

- **스폰**: `<bin> serve --hostname 127.0.0.1 --port <p> --pure`, `/doc` 폴링 60초 워티. 첫 챗 때 게이지 시작.
- **설정**: 기동마다 `configDir/opencode.json` 새로 생성 — provider baseURL=키프록시 주소, `removeAppPluginDirs`로 플러그인 파일 제거(#101).
- **env**: `OPENCODE_SERVER_PASSWORD`(매 실행 난수 Basic), `OPENCODE_DB`, `OPENCODE_CONFIG_DIR`, `OPENCODE_DISABLE_MODELS_FETCH/Sharing/AUTOUPDATE/…=1`, secret 패턴(`SECRET_ENGINE_ENV`)+`OPENCODE_*` 전수 제외, 동봉 rg를 PATH 맨 앞, NO_PROXY에 루프백.
- **재시작 트리거**: `providers/changed`, `features/changed`(가치 비교 후), `settings/changed`(claudeSkills), `setGate` — **돌던 턴은 끊김**. llm은 도는 턴 있으면 `gateIfIdle`/`reloadIfIdle`로 유예.
- **정리**: SIGTERM→5초→SIGKILL. PID 파일로 잔여 회수(명령줄+시작 시각 이중 확인). 지운 대화 본문은 bun:sqlite TRUNCATE+VACUUM으로 DB 파일에서 제거.
- 서버는 **하나**이며 세션마다 `?directory={프로젝트 폴더}`로 구분.

## 4. LLM 서비스 — `src/services/llm/`

- **프로토콜**: 채팅은 **레거시** `/session/*`. `POST /session?directory=` 생성 → `GET /event?directory=` **먼저** 구독 → `server.connected` 확인 → `POST /session/{id}/prompt_async?directory=` (204). 모든 호출에 `?directory=` 필수, 재구독 재생 없음(구독 우선), heartbeat 10초. 읽기 전용(모델 카탈로그·agent·pty·fs)만 신규 `/api/*`.
- **모델/에이전트 매 턴 명시** — 안 주면 외부 provider로 샌다. sticky 모델+매 build 에이전트를 `turnFields`로 싣음.
- **턴 끝 정의**: 이 턴 user 메시지를 **본 후의** `session.idle` (이전 idle은 버림). 끼어든 말 미달착 시 idle 보류. `session.error`는 사유 저장 후 idle 대기(없으면 `/session/status` 판정). 재시도/요약 상한 초과 시 abort, 모델 무응답 감시(`MODEL_STALL_TIMEOUT_MS`), SSE 끊김 → "중단됨"+abort.
- **승인/질문(attention)**: 이벤트는 신호만 — `GET /permission·/question?directory=` 재읽기가 정본 → `onAttention` + `llm/attention*`. 권정본 400이면 `permission.asked` 폴백. 카드 뜨기 **전** auto-판정(`llm/attention.ts` judge): `llm/pre-tool` serial(훅 — 막으면 reject) → 그 다음 (a) 게이트된 권한이고 모드 판정(`shared/modes.ts` `modePermission`)이 allow면 once / (b) 이 대화에서 [항상 허용]한 것(external_directory 패턴 + git 쓰기 전체)이면 once. 판정 표는 엔진 설정과 같은 표(모드×권한×자원)라 훅이 통과시킨 요청(allow)과 모드가 원래 묻는 요청(ask)을 가른다. **엔진에는 `always` 를 보내지 않는다** — 앱만 그 대화+권한(+패턴)을 기억하고(기억은 `host.allowed`, 앱 재시작 시 잊힘) 그 답을 once 로 보낸다(이슈 #242, git 쓰기 #307 — git 쓰기는 도구 상관없이 한 기억. 전체 권한 모드는 git 쓰기·폴더 밖·.env 도 안 묻고(하위 작업 제외), 보내기·만들기·브라우저 조작만 여전히 묻는다).
- **키 프록시**: opencode env는 프로젝트 플러그인·bash에 샌다 → **진짜 키는 opencode 에 절대 두지 않는다**.
  - 메인의 127.0.0.1 HTTP 서버가 `/<providerId>/<path>` → 저장된 baseURL로 중계.
  - 나가는 Authorization에만 진짜 Bearer. opencode는 실행마다 난수 토큰(`randomBytes(24)`)만 갖는다 — 새어도 키가 아니라 "앱 도는 동안 LLM 쓰기 권한"뿐.
  - 저장: `userData/providers.json`(메타) + `provider-keys.json`(safeStorage 봉인; Linux `basic_text` 백엔드는 거부).
- **`askOnce`**(자동 제목 등): 임시 세션, 도구 전부 차단(`tools:{"*":false}`), 끝나자 삭제.
- **폴더 문(`engineFolder`)**: 없거나 opencode 플러그인 파일이 있는 폴더 거부 — engineFolder 문에서 매 호출 확인.

## 5. 턴 흐름 (chat/sessions)

```
send() ── 도는 중? ──▶ SendQueues (origin 별 병합) ── 턴 끝나면 advance()
   │
   ▼
llm.chat({onSession}) ─▶ sessions.attach (engineSessionId 조기 연결 — 앱 꺼져도 재개)
   │
   ▼  llm/* 이벤트 follow (한 턴의 /event 스트림만 따라감)
   │
턴 끝 파이프라인: chat/after-turn serial (hooks 등)
              → sessions.patch (시각·engineSessionId·usage 합산)
              → chat/turn-ended
              → followUp (origin:'hook') → advance()
```

- **턴 소유**: `chat.turns: Map<cid, LiveTurn>` — 대화마다 한 턴. 화면/모바일은 `send()`만 하고 `chat/*`만 그림.
- **stop()**: 큐를 `hold`시켜 입력창으로 되돌림 (`takeQueue`).
- **끼워넣기**: `llm.reserve`로 도는 턴에 자리 → `chat/turn-interjected`.
- **삭제 sweep**: 삭제 실패한 엔진 세션은 `orphans`, 다음 기동 때 정리.

## 6. IPC·보안 (메인 ↔ 렌더러)

- **구조**: `shared/ipc.ts` — `Channel`(약 130개, `domain:verb`) + `LitecodeBridge` 인터페이스 + `Window.litecode` 타입. preload는 CJS라 채널 문자열을 **수동 재작성**(ipc.ts와 일치해야 한다는 주석만).
- **방향**: bidirectional IPC가 아니라 **invoke(렌더러→메인, 102개) + send(메인→렌더러 broadcast, 25개)** 조합.
- **preload**: `contextBridge.exposeInMainWorld('litecode', …)` — 약 113개 메서드(전체 목록 ipc.ts). 첨부 파일은 `webUtils.getPathForFile`으로만 경로 추출(렌더러가 path 문자열을 살 길 없음), 20MB 이하 스크린숏만 바이트로.
- **격리**: `contextIsolation: true, nodeIntegration: false`. 파일 읽기(미리보기·diff·git) 전부 메인 — 화면은 토큰만 보고 `resolveFiles`/`previewFile`로 판정 위임.
- **권한**: 하위프레임 전부 거부, 메인 프레임은 `clipboard-sanitized-write`+음성 켜졌을 때 `media`(오디오 1개)만. macOS 마이크는 OS 승인까지.
- **네비게이션**: `setWindowOpenHandler` 거부, origin 이탈 `will-navigate` 차단, iframe은 `about:srcdoc` 밖으로 못 감. 답의 링크는 `isWebUrl` 검사 후 OS 브라우저로만.
- **프로젝트 경계**: PREVIEW_*·LIST_DIRECTORY·GIT_*는 **등록된 프로젝트여야만** 동작(`ctx.projects.has` 재검증).
- **단일 인스턴스 잠금**: 두 번째 실행은 첫 창만 앞으로 — PID 기록 때문에 이전 실행의 opencode를 죽이는 것을 막기 위함.
- **resilience.ts**: `missingServices`(15초 부팅 진단)·`reloadGuard`(크래시 후 60초 내 3회)·`withDeadline`(종료 정리 8초, 초과 시 SIGKILL). 로그: `userData/logs/main.log` (1MB×3 로테이션, secret 마스킹).

## 7. 렌더러 (renderer/)

### 7.1 서비스 접근 3층

1. **preload 브리지** — `window.litecode`, 모든 RPC를 `ipcRenderer.invoke(채널)`, 이벤트는 `on`+해제 반환.
2. **계약** — `shared/ipc.ts`(채널+인터페이스), `shared/contract.ts`(Electron 모를 **중립 타입** — 모바일과 공유). `shared/ipc.ts`가 `src/services/*`에서 **type-only** 재수출(타입 정본은 서비스 쪽).
3. 렌더러는 `src/services` 런타임 코드를 import하지 않는다. 상태는 전에는 스토어가 메인과 동기화.

### 7.2 App 구조

- 라우팅 없음 — 단일 화면, `useState`로 프로젝트/대화 선택. **App이 상태 허브**(sessions[], projects[], drafts, 탭); 자식은 "그리기만".
- 트리는 `App.tsx`: `Rail`(접힘) + `Sidebar` + `main{ConversationView, Composer}` + `FilePreviewPanel`(별도 ErrorBoundary) + `SettingsModal`/`RemotePairPrompt`/Toasts + 루트의 `ProjectQuickOpen`. 터미널은 본문 아래 서랍이 아니라 `FilePreviewPanel` 의 탭 (#303) — `TerminalView`(xterm).
- 초기 로딩: `listConversations` → `chatSnapshot`(메인 소유의 live 턴 복원) → `listProjects` → 첫 프로젝트 자동 오픈.

### 7.3 상태 관리

- **전역 스토어**: `useSyncExternalStore` + 모듈 수준 state — settingsStore(메인 정본, 언어 바뀔 때 리렌더), featuresStore(메인 push), filePreviewStore(순수 화면 상태, chip↔panel 연결).
- **채팅 상태 머신**: `shared/chatReducer.ts` — **순수 리듀서로 모바일과 같음**. 이벤트: `turn.started → progress*(동일 id 전체 교체) / interjected(진행줄을 "얼린 답"으로) / attention / ended / queue.changed`. 렌더러는 `chatState.ts`가 `Session` 필드로 매핑, 이벤트 구독은 `useChatEvents`(1회, cid로 배분).
- `SendResult = 'sent' | 'queued' | 'interjected'`.
- **i18n**: 라이브러리 없는 사전 2종 `shared/i18n/{ko,en}.ts` — ko가 키 정본, en은 `satisfies`로 누락 컴파일 체크. 메인·렌더러·모바일 공통.

### 7.4 뷰 패턴 규칙

- `.tsx` = JSX 렌더링+핸들러 / `*View.ts` = **순수 로직**(React·시간·IPC 금지) / 컴포넌트별 `.css`(전역 `styles.css` 별도).
- 채팅: Markdown은 mdast→React (innerHTML 금지, 스트리밍 시 증분 파서); diff=`diffRows`+DiffCard; 툴 콜=접이식; 승인 카드는 주황 띠(Enter=한 번 허용/Esc=거절, [항상 허용]은 폴더 밖·git 쓰기 카드에만); 질문 카드는 보기+직수입; 모드 칩(Shift+Tab: plan→build→ask, full은 메뉴+확인); 작업/답 분할은 `splitTurn`; 진행 중 작업은 inputs 위 **jobs strip**(`Jobs.tsx`, #295).
- 입력: `+` 메뉴 트리거(`@`/`/`/`!`)는 `useTriggers`→메인 `queryTrigger` — 렌더러는 어떤 문자인지 모름. 첨부·음성(16kHz PCM)·대기열(QueueDock).
- 사이드바: 접힘/리사이즈, 진행중만 보기, 찾기, 고정/변경/삭제, **대화 이동 ⌘↑/⌘↓** (목록 순서·끝에서 감, `useSessionNav` #330) + 현재 대화 행 강조·"현재" 뱃지, **새 대화 ⌘N/Ctrl+N** (#344 — 버튼과 같은 동작·입력창 포커스 #343, 판·빠른 열기 열려 있으면 무시). **프로젝트 전환 = 빠른 열기**(#305): `ProjectQuickOpen` 전환 카드 옆(사이드바 우측) 패널, ⌘K/Ctrl+K(또는 전환 버튼)로 열고 타이핑 즉시 필터, ↑↓·Enter·Esc·Home/End, 즐겨찾기 ★ 먼저 — 옛 앵커형 popover 제거. **⌘K 반복 = 다음 프로젝트** (#375): 열려 있으면 ⌘K 가 열렸을 때 순서(즐겨찾기 먼저) 스냅샷의 다음 프로젝트를 열고 **패널을 유지** — 반복 시 계속 순환, 여는 중 누르면 무시. 순환은 `renderer/projectCycle.ts`(열면 최근 목록 맨 앞이라 live 순서가 아니라 스냅샷·커서) + `ProjectQuickOpen` effect.
- 설정 모달: 기본/모델/기능(4그룹: screen·ai·automation·devices)/모바일.
- 오른쪽 패널: Files/파일/Git/**터미널** 탭(filePreviewStore) — 터미널은 다중(번호=탭 이름)·닫아도 셸 유지·탭 닫으면 셸 종료. 단축키는 `useTerminalKeys`(⌘T 새 터미널·⌘[·⌘] 이전/다음, #303). PDF는 OS 앱으로.

## 8. 모바일 (mobile/, Android-Expo)

- **원칙**: 데스크탑의 "화면"일 뿐 — 대화 정본은 데스크탑, 짝이 없으면 연결 화면만.
- **운반 3종**(같은 `/v1` REST+SSE 계약):
  - **Wi-Fi**: 데스크탑이 TLS 1.3 자체서명 인증서 리스너(폰은 SPKI SHA-256 지문 고정), 평문은 루프백만. 기본 포트 47600. 사설 IPv4마다 바인딩, 10초 폴링으로 IP 추적.
  - **블루투스**: BLE peripheral, GATT rx/tx, **Noise NK** 인증, 폰 2대까지.
  - **프레이밍**(`shared/remoteFraming.ts`, 순수 TS라 양쪽 공용): L0 바이트링크 → L1 u16 길이 → (L2 Noise) → L3 다중화(REQ/RES/OPEN/DATA/END/CANCEL/PING) → L4 JSON/SSE. 16KB 조각, >1KB deflate, interleaving.
- **페어링**: 12자 Crockford 코드 2분/1회 + 2자리 숫자 같은 세션, 틀린 3회 폐기. 확인 코드 = `sha256("litecode-pair\n"+코드+기기명+플랫폼)` 40bit→8자 (TLS면 인증서 지문 앞 8자). **순수 TS sha256**(Hermes에 crypto 없음). 허용은 데스크탑 롱폴 60초 → 256bit 토큰(해시만 저장).
- **열리지 않는 것**: pty·fs·`!`·`@`·설정·키·MCP·스킬·full 모드(403). 인증 실패 10회/분→5분 차단.
- 기능: 대화 목록·채팅(보내기/중단/대기열/승인·질문), 알림, 유지(백그라운드 재연결), 음성 입력.
- 로컬 Expo 모듈 3종: keepalive(포그라운드 서비스), pinned-net(지문 고정 fetch), speech.

## 9. 빌드·패키징

- `npm run build` = typecheck + `vite build`(렌더러, `base:'./'` → file:// 설치본 지원) + `tsc -p tsconfig.electron.json`(ESM) + preload는 CJS(`preload.cts` — Electron이 항상 require로 읽기 때문).
- electron-builder: asar=true, bleno 네이티브만 unpack, `npmRebuild:false`, ad-hoc 서명. mac zip(arm64+x64) / win nsis.
- **동봉 자산**(모두 `build/vendor/`, 체크섬 대조 후 싣는다 — "레지스트리에서 다시 읽으면 릴리스가 바뀌어도 모른다"):
  - opencode 1.18.18 (npm 플랫폼 패키지, sha512 integrity + `--version` 확인)
  - ripgrep 15.1.0 (sha256 하드코딩)
  - speech: sherpa-onnx 1.13.8 + SenseVoiceSmall int8(239MB) + Silero VAD
  - browser: @playwright/mcp + playwright-core(7.6MB 트리밍) — **브라우저는 안 받음**(PC의 Chrome 사용)
- CI(`release.yml`): dev→main 시 macos-latest에서 unit 테스트 → vendor 3스크립트(캐시=스크립트 해시) → dist:mac+win → gh release.

## 10. 테스트

| 층 | 명령 | 내용 |
|---|---|---|
| unit | `npm test` | `tests/unit/` 114종 — 네트워크·외부 프로세스 없음. **착지 기준** |
| live | `npm run test:live` | `tests/live/` 30종 — 진짜 opencode 격리 + 가짜 LLM + 진짜 Electron 창. **미사용**(요청이 있을 때만, 8~9분) |
| dist | `npm run test:dist` | 설치본 .app 스모크 — 빈 PATH·격리 HOME·트래픽 기록 프록시로 동봉 자산 검증 |

착지 기준: `npm run typecheck` + `npm test` 초록.

## 11. 설계 노트·함정 (상시 기억)

1. `ctx.providers` 같은 서비스는 **inject 선언한 플러그인 안에서만** — `ctx.plugin` 직후 직렬 접근 금지.
2. cordis 4.x + `moduleResolution: NodeNext`에서 tsc가 `Context`/`Service` 값을 못 찾음 → `bundler`로 우회.
3. preload는 항상 CJS (`preload.cts`).
4. 서비스 생성자가 던지면 영영 안 뜨고 inject한 쪽이 말없이 기다림 → `readJsonFileSync` 패턴.
5. opencode env는 새어 나가므로 **진짜 키는 메인에만** (키 프록시).
6. 프로젝트 폴더(와 상위)의 opencode 플러그인 파일은 엔진 안에서 실행된다 → `engineFolder` 문에서 거부.
7. 설정 변경은 엔진 재시작으로만 적용 + 재시작 시 도는 턴이 끊김.
8. 레거시 세션 경로는 `?directory=` 필수, `server.connected` 확인 후 전송, 구독 재생 없음.
9. `GET /permission` 정본은 400 가능 → `permission.asked` 이벤트 폴백. **엔진의 `always` 는 보내지 않는다**(그 폴더 모든 세션에 걸림) — 카드의 [항상 허용]은 앱이 그 대화만 기억하고 once 로 답하는 것.
10. 렌더러는 `src/services` 런타임 import 불가 — `window.litecode` 브리지 + type-only 재수출만.
