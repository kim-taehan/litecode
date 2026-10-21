# LiteCode 프로젝트 구조 분석 리포트

- 작성일: 2026-10-15
- 기준 커밋: `dev` @ 0c5e730 (PR #414 머지 직후)
- 범위: 저장소 구조, 진입점, 의존성, 기술 스택, 프로세스·서비스·데이터 흐름

---

## 1. 프로젝트 개요

**LiteCode** — 폐쇄망(에어갭) 환경용 "원클릭 code assistant". 데스크톱 하나면 끝나는 설치형 AI 코딩 어시스턴트다.

| 속성 | 내용 |
|---|---|
| 패키지명 / 버전 | `litecode` / 0.0.1 (private, ESM) |
| 목적 | 사내 LLM 게이트웨이 주소를 넣으면 프로젝트 폴더에서 대화하며 코드를 읽·고·수정·실행 |
| 폐쇄망 원칙 | 런타임 다운로드 0 · 외부 요청 0 — 엔진(opencode)·검색(ripgrep)·음성 엔진을 설치본에 전부 동봉하고 체크섬 검증 후 싣는다 |
| 플랫폼 | macOS (arm64/x64) · Windows (데스크톱), Android (동반 앱) |
| 핵심 경계 | 화면(렌더러·모바일)은 "손님 화면"일 뿐 — 모든 로직은 Electron 메인 프로세스. 에이전트 루프는 opencode 1.18.18 고정 버전을 그대로 사용 |
| 플러그인 뼈대 | Cordis 4.0.0-rc.10 — `ctx.<키>` 로 서비스 등록, `inject` 로 의존성·부팅 순서 표현 |

### 진입점 (entry point)

| 진입점 | 위치 | 목적 |
|---|---|---|
| Electron 메인 | `electron/main.ts` (~993줄) — `package.json` main = `dist-electron/electron/main.js` | 실제 앱 전체 (서비스 올림·이벤트 브로드캐스트·창 관리) |
| Preload | `electron/preload.cts` (CJS 고정) | `window.litecode` 브리지 (~113 메서드) |
| 렌더러 | `renderer/index.html` → `renderer/main.tsx` → `App.tsx` | React UI |
| 스파이크 | `src/index.ts` (`npm run spike`) | Electron 없이 서비스 배선만 올리는 최소 확인 |
| 모바일 | `mobile/index.ts` (Expo) | Android 동반 앱 (독립 패키지) |

### 개발/빌드/테스트 명령어

| 명령 | 설명 |
|---|---|
| `npm run dev` | vite(5174) + electron 개발 모드 (`scripts/dev.mjs`) |
| `npm run typecheck` | `tsc --noEmit` (착지 기준 1) |
| `npm test` | vitest 단위 테스트 (~129파일, 착지 기준 2) |
| `npm run test:live` | 실물 30종 — 격리된 진짜 opencode + 가짜 LLM + 진짜 Electron 창 |
| `npm run test:dist` | 설치본 `.app` 스모크 — 빈 PATH·격리 HOME |
| `npm run build` | typecheck + `vite build`(렌더러) + `tsc -p tsconfig.electron.json` |
| `npm run dist:mac` / `dist:win` | vendor 3종 체크섬 확인 → 빌드 → electron-builder → `release/` |

---

## 2. 기술 스텍

| 영역 | 선택 | 비고 |
|---|---|---|
| 언어 | TypeScript 5.6 | ESM (`"type": "module"`), 서비스는 런타임 import에 `.ts` 확장자 사용 |
| 데스크톱 shell | Electron 33 | 보안: `contextIsolation: true`, `nodeIntegration: false`, 단일 인스턴스 잠금 |
| UI 프레임워크 | React 19 + Vite 8 | 렌더러 전용, `base: './'`로 file:// 설치본 지원 |
| DI/서비스 프레임워크 | **Cordis 4.0.0-rc.10** (정확히 고정) | 서비스·플러그인(effect/fiber)·이벤트(`서비스/이벤트`). 4.x + NodeNext tsc 문제로 `moduleResolution: bundler` |
| AI 엔진 | **opencode 1.18.18** (동봉 바이너리) | 외부 프로세스, `127.0.0.1` REST+SSE. 에이전트 루프·툴·압축을 그대로 재사용 |
| 터미널 | xterm + `@xterm/addon-fit` | 앱 내 셸 세션(pty) |
| 암호/암호화 | @noble/hashes · curves · ciphers | 순수 TS — sha256·Noise NK(모바일 페이로드)·페어링 코딩 |
| WebSocket / HTTP 클라이언트 | ws · undici | 키 프록시·MCP 클라이언트·리모트 |
| 마크다운 | micromark/mdast/lowlight + highlight.js | innerHTML 없이 mdast→React, 스트리밍 증분 파서 |
| 음성 | sherpa-onnx 1.13.8 + SenseVoiceSmall int8 (239MB) + Silero VAD | utilityProcess(코어)에서 인코딩, 죽어도 메인 산다 |
| 브라우저 자동화 | playwright-core 7.6 (브라우저 미포함, PC의 Chrome 사용) | `browser` 기능 — Playwright MCP 등록 |
| QR | qrcode-generator | 모바일 페어링 QR |
| 모바일 | React Native 0.86 + Expo 57 | `mobile/` 독립 npm 패키지(의존성 불합치), BLE는 react-native-ble-manager |
| 네이티브 (모듈) | @stoprocent/bleno (BLE peripheral) | electron-builder에서 unpack 대상, `npmRebuild: false` |
| 테스트 | vitest 5 (3 계층: unit/live/dist) | live는 playwright-core로도 UI 검증 |
| 패키징 | electron-builder | asar=true, ad-hoc 서명. mac zip / win NSIS |
| CI | GitHub Actions (`.github/workflows/release.yml`) | dev→main: unit 테스트 → vendor 스크립트 3종(해시 캐시) → dist → gh release |

**핵심 의존 관계 (package.json dependencies)**: `cordis`(뼈대) · `react/react-dom` · `@xterm/*` · `@noble/*` · `ws` · `undici` · `@stoprocent/bleno` + 마크다운 체인 + `qrcode-generator`. devDeps는 electron · electron-builder · vite · vitest · tsx · typescript · playwright-core.

---

## 3. 디렉터리 구조 (역할 포함)

```
litecode/
├── electron/            # 🖥️ 메인 프로세스 진입점과 시스템 호스트 (Electron 전용 코드는 이 안에만)
│   ├── main.ts          #   단일 entry — 부팅 순서, Cordis Context 1개, *Bridge(서비스↔IPC), 기능 묶음 정의
│   ├── preload.cts      #   CJS 고정 — contextBridge로 window.litecode 노출 (채널 문자열은 수동 재기록)
│   ├── resilience.ts    #   부팅 진단(15초) · 크래시 재로드 가드(60초 3회) · 정리 타임아웃
│   ├── keyStorage.ts    #   safeStorage(메타+봉인 키). Linux basic_text 백엔드는 거부
│   ├── speechWorker.ts  #   음성 인코딩 utilityProcess (sherpa-onnx) — 죽어도 메인 산다
│   └── *Host.ts         #   attachments/notification/openIn/quit/report/speech —
│                        #   "설정 값(host)으로 시스템 호출을 서비스 밖에서" 주입하는 호스트
├── src/                 # ⚙️ 메인 프로세스 서비스 (Electron을 import 하지 않는 순수 로직)
│   ├── services/        #   67개 서비스 파일 + 6개 서브디렉터리
│   │   ├── llm/         #     opencode 대화 경계: service · follow(턴 추적) · attention(승인/질문 판단)
│   │   │                #       engineApi · prompt · limits · types (엔진 지식은 여기+engine에만)
│   │   ├── remote/      #     모바일 연결: service(상태/운반/이벤트링) · routes(REST표) · pairRequest
│   │   │                #       chatEvents · wire(계약 순수함수) · http/https/tlsIdentity ·
│   │   │                #       bluetooth/noiseIdentity · framed · limits · devices · streamQueue
│   │   ├── appMcp/      #     앱 내장 MCP 서버: rpc · forwardSkill · tools/{open,present,sessions,
│   │   │                #       make,tasks,git} → litecode_* 도구
│   │   ├── browser/     #     Playwright MCP 자산/정리
│   │   ├── speech/      #     음성: audio/bridge/stream/assets (동봉 모델 경로)
│   │   ├── hooks/       #     사용자 셸 훅: bridge/config/run/sample
│   │   └── (핵심 단일 파일) settings providers engine engineConfig llm chat sessions
│   │                     projects triggers terminals shell skills mcp mcpClient appMcp
│   │                     git git remote ... keyProxy opencodeBinary opencodePty attach...
│   ├── triggers/        #   입력 트리거: at.ts(@파일) · slash.ts(/명령) · bang.ts(!shell)
│   ├── i18n.ts          #   tr() 헬퍼 (사전은 shared/i18n/{ko,en})
│   └── index.ts         #   스파이크 진입점 (Electron 없는 배선 확인)
├── shared/              # 📜 메인·렌더러·모바일이 공유하는 계약 (32개 — 런타임 순수 코드 다수)
│   ├── ipc.ts           #   Channel ~130개(domain:verb) + LitecodeBridge 인터페이스 (type-only 재수출)
│   ├── contract.ts      #   Electron을 모르는 중립 타입 (모바일과 공유)
│   ├── chat.ts/ chatReducer.ts  # ChatEventMap + 순수 채팅 상태 머신 (모바일과 동일한 리듀서)
│   ├── features.ts      #   기능 묶음 id·기본값·FEATURE_REQUIRES·4그룹(화면/AI/자동화/기기)
│   ├── modes.ts         #   에이전트 모드(plan/build/ask/full) × 권한 × 자원 판정표
│   ├── remoteFraming.ts # L0 바이트링크→L1 u16길이→(L2 Noise)→L3 다중화→L4 JSON/SSE (양쪽 공용)
│   ├── git.ts skills.ts mcpTools.ts hooks.ts speech.ts usage.ts ...
│   └── i18n/{ko,en}.ts  #   라이브러리 없는 사전 2종 (ko 키 기준, en satisfies로 누락 체크)
├── renderer/            # 🖼️ React UI (163개 — contextIsolation, nodeIntegration off)
│   ├── main.tsx / App.tsx       # entry + 상태 허브 (sessions/projects/drafts/탭 전역 useState)
│   ├── ConversationView.tsx / ChatTurn.tsx / Composer.tsx  # 채팅 본문·턴·입력
│   ├── Sidebar.tsx / Rail.tsx / ProjectQuickOpen.tsx      # 좌측 내비·프로젝트 빠른 열기(⌘K)
│   ├── FilePreview.tsx TerminalView.tsx Git*.tsx Tasks... # 오른쪽 패널 탭(파일/Git/터미널)
│   ├── Settings.tsx FeaturesSettings.tsx HooksImport.tsx ...  # 설정 모달
│   ├── *View.ts (수많은)        # 순수 로직 규칙: React·시간·IPC 금지 — React 없이 테스트 가능
│   └── *.css             # 컴포넌트별 CSS (전역 styles.css 별도)
├── mobile/              # 📱 Android 동반 앱 — "두 번째 화면" (단독 세션 없음)
│   ├── package.json     #   독립 npm(의존성 불합치). expo 57 / RN 0.86
│   ├── src/app/         #   화면·알림·BLE 드라이버·원격 세션(remoteSession)
│   ├── src/core/        #   블투/프레임/압축/SSE/페어링 QR — shared/remoteFraming 재사용
│   ├── modules/         #   Expo 로컬 네이티브 3종: keepalive · pinned-net · speech
│   ├── dev/fake-desktop.mts   # 데스크톱 없이 앱 개발용 가짜 데스크톱
│   └── tests/ scripts/  #   vitest + APK 빌드 스크립트
├── build/               # 📦 electron-builder 자산
│   ├── vendor/          #   동봉 런타임(모두 체크섬 검증): opencode/ rg(ripgrep) speech/ browser/
│   └── icon.* afterPack.cjs
├── scripts/             # 🔧 dev.mjs · fetch-opencode.mjs · fetch-speech.mjs · fetch-browser.mjs
├── docs/                # 📚 컨트리뷰터 문서 (구조 이해의 정본)
│   ├── architecture.md       #   전체 아키텍처 (이번 리포트와 동일한 시각)
│   ├── cordis-services.md    #   서비스 지도·의존·부팅·함정
│   ├── opencode-protocol.md  #   opencode REST+SSE 프로토콜 실측 기록
│   └── status.md             #   조각별 진행 상태
├── tests/               # 🧪 vitest 3계층
│   ├── unit/            #   ~129파일 — 네트워크/외부 프로세스 없음 (착지 기준)
│   ├── live/            #   30종 — 진짜 opencode 격리 + 가짜 LLM + Electron 창 (8~9분, 요청 시에만)
│   ├── dist/            #   설치본 .app 스모크
│   └── fixtures/        #   noise-vectors 등
├── release/ dist/ dist-electron/   # 🚚 빌드 산출물 (gitignore)
├── tsconfig.json (renderer, bundler) / tsconfig.electron.json (ESM)
├── vite.config.ts / vitest.config.ts / vitest.live.config.ts / vitest.dist.config.ts
├── electron-builder.yml — asar=true, bleno unpack, ad-hoc 서명
└── AGENTS.md / CLAUDE.md — 기여 워크플로우·코드 컨벤션 (issue → dev에서 feat_/fix_ 브랜치 → PR)
```

---

## 4. 아키텍처

### 4.1 프로세스 구성 (큰 그림)

```
┌──────────────────────────── Electron 메인 프로세스 ────────────────────────────┐
│  Cordis Context (1개)  ← 모든 서비스·IPC 핸들러·턴 실행이 여기                 │
│  ├ 설정·프로바이더·프로젝트·세션·트리거 …                                     │
│  ├ chat (턴 소유) ── llm ── engine ──▶ opencode 자식 프로세스 (REST+SSE)      │
│  ├ 키 프록시 HTTP (진짜 Bearer 키는 여기에만)                                 │
│  ├ appMcp MCP 서버 (127.0.0.1 + 매 실행 토큰)                                │
│  └ 리모트 리스너 (Wi-Fi TLS / BLE)                                           │
├─────────────────────────────────────────────────────────────────────────────── │
│  utilityProcess: 음성 인코딩 (sherpa-onnx) — 죽어도 메인 산다                 │
└───────────────────────────────────────────────────────────────────────────────┘
        ▲                    ▲
        │ IPC (invoke+send)  │ HTTP /v1 (REST+SSE, 같은 계약)
┌───────┴────────┐   ┌──────┴────────┐
│ 렌더러 (React) │   │ 모바일 (Android) — "두 번째 화면", 단독 세션 없음        │
└────────────────┘   └───────────────┘

opencode(1.18.18 고정) ──▶ 사내 LLM 게이트웨이 (LiteLLM 등)   ← 폐쇄망, 바깥 0
```

핵심 설계 결정:
1. **엔진은 opencode를 그대로 쓴다.** 에이전트 루프(툴·프롬프트·압축)를 재구현하지 않고 `ctx.llm` 뒤에 숨긴다 — 엔진 지식은 `llm`+`engine` 두 서비스에만 한정, 교체 시 이 경계만.
2. **모든 로직은 메인.** 렌더러·모바일은 "손님 화면" — `chat.send` 호출과 이벤트를 받는 것만.
3. **진짜 API 키는 opencode에 주지 않는다.** 메인 프로세스의 키 프록시가 나가는 요청에 Bearer를 붙여준다.
4. **기능 묶음(feature bundle)** — 설정에서 끄면 코드 통째로 내려감 (IPC 핸들러·이벤트 구독까지 fiber dispose로 정리).

### 4.2 서비스 레이어 (Cordis)

#### 4.2.1 기반 서비스 (`electron/main.ts`가 직접 올림)

| ctx 키 | 파일 | inject | 역할 |
|---|---|---|---|
| `settings` | settings.ts | — | 앱 설정 정본(settings.json), 값 검증·기본값 폴백 |
| `providers` | providers.ts | — | 모델 provider 카탈로그 + safeStorage 봉인된 API 키 |
| `engine` | engine.ts | providers | opencode 1개 수명, 기동마다 설정 재생성, 키 프록시 |
| `llm` | llm/ | providers, engine | opencode 경계 전부 — 턴·구독·승인·질문·기록 |
| `projects` | projects.ts | — | 최근/즐겨찾음 프로젝트(=폴더) 목록, realpath 식별 |
| `sessions` | sessions.ts | llm | 대화 메타(sessions.json) — **내용 정본은 opencode DB** |
| `triggers` | triggers.ts | — | 입력 트리거(`@`/`/`/`!`) 등록소 |
| `chat` | chat.ts | llm, sessions, providers | 대화별 턴 소유 — 보내기·대기열·턴 끝·중지 |
| `attachments` | attachmentsService.ts | chat | 첨부 골라읽기 |
| (플러그인) | autoTitle.ts | llm, sessions, settings | 첫 턴 뒤 `askOnce`로 자동 제목 |
| `features` | features.ts | settings | 기능 레지스트리 — serial mount/unmount |
| `quit` | quit.ts | chat, settings | 종료 확인, 창 닫기=숨기기 |
| `report` | report.ts | llm, sessions, … | 대화 내보내기·신고 번들 (로컬 저장만) |

#### 4.2.2 기능 묶음 (설정에서 on/off)

| 기능 | ctx 키 | 비고 |
|---|---|---|
| `shell`·`skills`·`mcp`·`terminal`·`openIn` | (필수, 고정 켜짐 — `terminal`·`openIn`은 2026-10-15부터) | `!`명령, 스킬, MCP 서버 관리, pty 다중 터미널, 타 앱에서 열기 |
| `trajectory` `appMcp` `repeatGuard` | 기본 켜짐 | 추론 기록, 내장 MCP 도구, 반복 도구 감시 |
| `notifications` `remote`(`lan`+`bluetooth`) `hooks` `voice` `browser` `updates` `git` `web` | 기본 꺼짐 | 알림, 모바일 연결, 셸 훅, 음성, Chrome 조종, 업데이트 (기능 화면 카드 잠정 숨김 2026-10-15), git 도구, webfetch |

- `FEATURE_REQUIRES`: `bang→shell`, `appMcp→mcp`, `browser→mcp`, `lan/bluetooth→remote`
- `skills`·`web`·`appMcp`·`browser` 변경은 엔진 설정에 영향 → `features/changed` 들은 engine이 재시작 (도는 턴은 끊김)
- 올리고 내리기는 한 줄 큐로 serial — `ipcMain.handle` 중복 등록 방지

#### 4.2.3 부팅 순서와 방식

`settings → providers → engine → llm → projects → sessions → triggers → bootstrap(inject 8종) → chat+chatBridge → autoTitle → attachments → report → quit → 기능 묶음 등록 → FeaturesService(마지막)`

- `static readonly inject = ['a','b']`만 선언하면 그 서비스가 마운트된 뒤 자동 생성 — 사람이 순서를 안 짜도 됨
- **함정 1**: `ctx.plugin(X)` 직후 줄에서 `ctx.x` 접근 금지 (비동기 마운트)
- **함정 2**: 생성자가 던지면 그 서비스는 영영 안 뜬다 → 파일은 `readJsonFileSync` 패턴(모양 다르면 이동+기본값)으로만
- 15초 기한 미달 서비스는 로그+대화상자 (`resilience.ts missingServices`)

### 4.3 데이터·통신 흐름

#### 4.3.1 IPC (렌더러 ↔ 메인)

- **계약**: `shared/ipc.ts` — `Channel` ~130개(`domain:verb` 형태) + `LitecodeBridge` 인터페이스 + `Window.litecode` 타입
- **방향**: bidirectional IPC가 아니라 **invoke(렌더러→메인, ~102개) + send(메인→렌더러 broadcast, ~25개)**
- **preload**: CJS 고정, `contextBridge.exposeInMainWorld('litecode', …)` 약 113메서드. 첨부 파일은 `webUtils.getPathForFile`으로만 경로 추출
- **격리**: 파일 읽기(미리보기·diff·git) 전부 메인에서 — 화면은 토큰만 보고 `resolveFiles`/`previewFile`로 판정 위임
- **권한**: 하위프레임 거부, `clipboard-sanitized-write`+음성 켜졌을 때만 `media`. 링크는 `isWebUrl` 검사 후 OS 브라우저로만
- **프로젝트 경계**: PREVIEW_*/LIST_DIRECTORY/GIT_*는 **등록된 프로젝트여야만** 동작 (`ctx.projects.has` 재검증)

#### 4.3.2 엔진 프로토콜 (메인 ↔ opencode)

- `POST /session?directory=` 생성 → `GET /event?directory=` **먼저** 구독 → `server.connected` 확인 → `POST /session/{id}/prompt_async?directory=` (204)
- 모든 호출에 `?directory=` 필수, 재구독 재생 없
  , heartbeat 10초
- 모델/에이전트는 매 턴 명시 (안 주면 외부 provider로 샌다)
- **턴 끝 정의**: 이 턴 user 메시지를 본 후의 `session.idle`
- **승인/질문**: 이벤트는 신호만 — `GET /permission·/question` 재읽기가 정본. 카드 뜨기 전 auto-판정(`llm/attention.ts`): `llm/pre-tool` serial(훅이 막으면 reject) → 모드×권한×자원표(`shared/modes.ts`)로 allow면 once. **엔진에는 `always`를 보내지 않는다** — 앱이 그 대화+권한만 기억하고 once로 답
- **키 프록시**: 메인 127.0.0.1 HTTP 서버가 `/<providerId>/<path>` → 저장된 baseURL로 중계. opencode는 실행마다 난수 토큰만 보유 (새어도 키가 아님)
- 저장: `userData/providers.json`(메타) + `provider-keys.json`(safeStorage 봉인)

#### 4.3.3 모바일 (Android ↔ 데스크톱)

- **원칙**: 대화 정본은 데스크톱 — "화면"일 뿐, 단독 세션 없음
- **운반 3종** (같은 `/v1` REST+SSE 계약):
  - **Wi-Fi**: 데스크톱이 TLS 1.3 자체서명 인증서 리스너, 폰은 SPKI SHA-256 지문 고정. 기본 포트 47600
  - **블루투스**: BLE peripheral + GATT, **Noise NK** 인증, 폰 2대까지
  - **프레이밍**(`shared/remoteFraming.ts`, 순수 TS라 양쪽 공용): L0 바이트링크→L1 u16길이→(L2 Noise)→L3 다중화(REQ/RES/OPEN/DATA/END/CANCEL/PING)→L4 JSON/SSE. 16KB 조각, >1KB deflate
- **페어링**: 12자 Crockford 코드 2분/1회 + 2자리 숫자 같은 세션, 틀린 3회 폐기. 확인 코드 = `sha256("litecode-pair\n"+코드+기기명+플랫폼)` 40bit→8자 (순수 TS sha256 — Hermes에 crypto 없음)
- **열리지 않는 것**: pty·fs·`!`·`@`·설정·키·MCP·스킬·full 모드 (403). 인증 실패 10회/분→5분 차단

#### 4.3.4 이벤트 계약 (이름 규칙: `서비스/이벤트`)

| 이름 prefix | 뜻 | 수신자 |
|---|---|---|
| `llm/*` | **엔진의 사실** — turn-started/ended, attention, tool-started/done, before-turn/pre-tool serial | notifications·hooks·repeatGuard |
| `chat/*` | **화면/모바일이 보는 상태** — turn-started/progress/attention/ended, queue-changed, before-send/after-turn serial | 렌더러·모바일 (chat이 브리지로 broadcast) |
| `sessions/removed` | 대화 삭제 | chat(큐/턴 abort) + notifications + sweep |
| `features/changed` | 기능 묶음 올리고 내린 뒤 | engine(재시작) |

### 4.4 턴 (Turn) 흐름

```
렌더러/모바일: chat.send()
   │
   ▼
chat.send ── 도는 중? ──▶ SendQueues (origin별 병합) ── 턴 끝나면 advance()
   │
   ▼
llm.chat({onSession}) ─▶ sessions.attach (engineSessionId 조기 연결 — 앱 꺼져도 재개)
   │  llm/* 이벤트 follow (한 턴의 /event 스트림만 따라감)
   ▼
턴 끝 파이프라인: chat/after-turn serial (hooks 등)
               → sessions.patch (시각·engineSessionId·usage 합산)
               → chat/turn-ended
               → followUp (origin:'hook') → advance()
```

- **턴 소유**: `chat.turns: Map<cid, LiveTurn>` — 대화마다 한 턴. 화면/모바일은 `send()`만 하고 `chat/*`만 그림
- **stop()**: 큐를 hold시켜 입력창으로 되돌림. **끼워넣기**: `llm.reserve`로 도는 턴에 자리
- 채팅 상태 머신은 `shared/chatReducer.ts`의 **순수 리듀서** — 모바일과 동일한 로직

### 4.5 렌더러 구조

- **라우팅 없음** — 단일 화면, `App.tsx`가 상태 허브 (sessions[], projects[], drafts, 탭). 자식은 "그리기만"
- **서비스 접근 3층**: preload 브리지(`window.litecode`) → 계약(`shared/ipc.ts` + `shared/contract.ts` 중립 타입) → 렌더러는 `src/services` 런타임 코드를 import하지 않음 (type-only 재수출만)
- **상태 관리**: `useSyncExternalStore` + 모듈 수준 state (settingsStore·featuresStore·filePreviewStore)
- **뷰 패턴 규칙**: `.tsx` = JSX 렌더링+핸들러 / `*View.ts` = **순수 로직**(React·시간·IPC 금지) / 컴포넌트별 `.css`
- **채팅**: Markdown은 mdast→React (innerHTML 금지, 스트리밍 증분 파서). 툴 콜=접이식. 승인 카드는 주황 띠. 모드 칩(Shift+Tab: plan→build→ask)
- **오른쪽 패널**: Files/파일/Git/**터미널** 탭 — 다중 터미널(번호=탭 이름), 탭 닫으면 셸 종료

### 4.6 보안 설계 요약

| 레이어 | 조치 |
|---|---|
| 렌더러 격리 | contextIsolation on, nodeIntegration off, 하위프레임 전부 거부, setWindowOpenHandler 거부 |
| 키 보호 | safeStorage 봉인 + 키 프록시 (opencode는 난수 토큰만) + 로깅 시 secret 마스킹 |
| 엔진 격리 | `OPENCODE_*` env 전수 제외 + secret 패턴. `removeAppPluginDirs`로 플러그인 파일 제거. 폴더에 opencode 플러그인 파일 있으면 `engineFolder`에서 거부 |
| 프로젝트 경계 | 파일/터미널/git IPC는 등록된 프로젝트 폴더 재검증 |
| 모바일 | 페어링 코드 + TLS 지문 고정(또는 Noise NK) + 256bit 토큰(해시만 저장) + 실패 차단 |
| 단일 인스턴스 | 두 번째 실행은 첫 창만 앞으로 — PID 기록 때문에 이전 실행의 opencode를 죽이는 것을 방지 |

### 4.7 빌드·패키징

- `vite build` (렌더러, `base:'./'` → file:// 지원) + `tsc -p tsconfig.electron.json` (ESM) + preload CJS
- electron-builder: asar=true, bleno 네이티브만 unpack, `npmRebuild:false`, ad-hoc 서명. mac zip(arm64+x64) / win NSIS
- **동봉 자산** (`build/vendor/`, 체크섬 대조 후 싦): opencode 1.18.18 (sha512) · ripgrep 15.1.0 (sha256) · sherpa-onnx + SenseVoiceSmall (239MB) · playwright-core
- CI: `release.yml` — dev→main 시 unit 테스트 → vendor 스크립트(해시 캐시) → dist:mac+win → gh release

### 4.8 테스트

| 계층 | 명령 | 내용 | 비고 |
|---|---|---|---|
| **unit** | `npm test` | `tests/unit/` ~129종 | 네트워크·외부 프로세스 없음. **착지 기준** |
| live | `npm run test:live` | `tests/live/` 30종 | 진짜 opencode 격리 + 가짜 LLM + Electron 창. 8~9분, 요청 시에만 |
| dist | `npm run test:dist` | 설치본 `.app` 스모크 | 빈 PATH·격리 HOME·트래픽 기록 프록시로 동봉 자산 검증 |

**착지 기준**: `npm run typecheck` + `npm test` 초록.

---

## 5. 구조적 특징 한줄 요약

- **Cordis가 뼈대, opencode가 두뇌, Electron이 몸통, React가 얼굴, Android가 두 번째 얼굴**
- 엔진 지식은 `llm`+`engine`에, 계약은 `shared/`에, 시스템 호출은 `electron/*Host`로 주입 — 그래서 서비스는 Electron 없이 단위 테스트가 된다
- "손님 화면" 원칙(렌더러·모바일이 다 손님) + "진짜 키는 메인에만" + "기능 끄면 코드 통째로 사라짐" 이 세 원리가 전체 구조를 지배한다
- 상세 정본: `docs/architecture.md` (전체) · `docs/cordis-services.md` (서비스 지도) · `docs/opencode-protocol.md` (프로토콜 실측) · `docs/status.md` (조각별 상태)
