# Cordis 서비스 지도 (2026-10-07)

litecode 의 메인 프로세스는 [Cordis](https://github.com/cordiverse/cordis) 위에 서 있다. 서비스는 `ctx.<키>` 로 등록되고 키로 찾아 쓴다.
이 문서는 **어떤 서비스가 있고, 서로 어떻게 기대고, 어떻게 뜨고 내려가는지**를 한 곳에 모은다. 조각별 상세·실측은 `docs/status.md`,
opencode 쪽은 `docs/opencode-protocol.md` 가 정본이다 — 여기에는 구조만 적는다.

## 1. Cordis 를 이렇게 쓴다

| Cordis 개념 | litecode 에서 |
|---|---|
| **서비스** (`class X extends Service`, `super(ctx, '키')`) | `ctx.키` 로 접근. 타입은 파일 안의 `declare module 'cordis' { interface Context { 키: X } }` 로 더한다 |
| **inject** (`static readonly inject = ['a', 'b']`) | 그 서비스들이 뜰 때까지 **자동으로 기다렸다가** 올라온다. 순서는 사람이 짜지 않고 inject 로 표현한다 |
| **플러그인** (`ctx.plugin(fn 또는 class, 설정)`) | 서비스·IPC 연결·기능 묶음 모두 플러그인이다. 반환값(fiber)을 `dispose()` 하면 안에서 건 모든 것이 걷힌다 |
| **effect** (`ctx.effect(() => { … return 정리 })`) | IPC 핸들러·이벤트 구독처럼 "걸었다 풀어야 하는 것"은 전부 effect 로 건다 |
| **이벤트** (`ctx.emit('x/y', …)`, `ctx.on('x/y', …)`) | 이름은 `서비스/이벤트`. 타입은 `interface Events` 에 더한다 |

원칙 둘:
- **서비스는 엔진(opencode)·Electron·화면을 몰라도 단위 테스트가 된다.** 파일 경로·시스템 호출(`safeStorage`·`shell.openPath` 등)은 `electron/main.ts` 가 **설정 값(host)** 으로 넘긴다.
- **opencode 는 `ctx.llm`(과 그 아래 `ctx.engine`) 뒤에만 있다.** 위층은 이 키만 알고 엔진을 직접 모른다. 엔진을 바꿔도 이 경계만 교체한다.

## 2. 서비스 지도

### 2-1. 바탕 — 끌 수 없다 (`electron/main.ts` 가 직접 올린다)

| 키 | 파일 | 하는 일 | inject |
|---|---|---|---|
| `settings` | `src/services/settings.ts` | 앱 설정(`settings.json`) — 언어·테마·글자 크기·기능 켜기. 잘못된 값은 그 값만 기본값으로. `settings/changed` | — |
| `providers` | `providers.ts` | 모델 provider 목록·키(키는 `safeStorage` 로 봉인). `providers/changed` | — |
| `engine` | `engine.ts`·`engineConfig.ts` | opencode 서버 하나를 띄우고 설정(`opencode.json`)을 **기동마다 새로 만든다**, 키 프록시, MCP·권한 규칙 | `providers` |
| `llm` | `llm.ts`(진입점)·`llm/*`(서비스·턴 따라가기·승인·엔진 호출, #289) `history.ts` | 엔진과의 대화 — 턴·구독·승인·질문·기록. `model`·`agent` 를 매 턴 명시. 엔진 지식은 `llm` 과 `engine` 에만 | `providers`, `engine` |
| `projects` | `projects.ts` | 최근 프로젝트 목록 | — |
| `sessions` | `sessions.ts` | 대화 목록(제목·시각·모델·통계·고정·마지막에 보던 대화). 내용의 정본은 opencode DB | `llm` |
| `triggers` | `triggers.ts` | 입력창 트리거(`@` `/` `!`) 등록소 — 트리거 플러그인이 effect 로 등록 | — |
| `chat` | `chat.ts` | **대화별 턴 소유** — 보내기·대기열·턴 끝 처리(제목·저장·통계)·중지. 화면은 손님이다 | `llm`, `sessions`, `providers` |
| `attachments` | `attachmentsService.ts` | 첨부(붙인 이미지·파일 읽기) | `chat` |
| (플러그인) | `autoTitle.ts` | 자동 대화 제목(#215, 설정 `autoTitle` 기본 꺼짐) — `chat/turn-*` 만 듣고 첫 턴 뒤 `ctx.llm.askOnce`(임시 세션, 끝나면 지운다)로 제목을 받아 `ctx.sessions.autoTitle`(사용자가 바꾼 이름은 안 덮는다), `chat/conversations-changed` 를 낸다. 키 없음 | `llm`, `sessions`, `settings` |
| `extensions` | `extensions.ts` (+ 저장소 `extensions/*`, 모양 `shared/extensions.ts`) | 설치한 확장(zip, #482) — 부팅 때 남은 보류 적용(비정상 종료 복구) → `installed/` 재검증 → 켜진 확장 올림(`mount` 주입 자리 — 비어 있고 상태만 on). 켜짐 값 `settings.extensions`, 켜고 끄기는 곧바로(큐). 설치·업그레이드·삭제도 그 호출 안에서 곧바로 적용(#511). 목록 `ExtensionSummary` 에 manifest 의 선택 필드 `details`(여러 줄 긴 설명, #519)도 싣는다. 패널 확장(#511): `readEntry(id)` 가 켜진 정상 확장의 진입 HTML 을 돌려주고 화면이 격리된 iframe 에서 돌린다(메인은 실행하지 않는다). 언어 팩(#525, manifest `type: 'locale'`): `readLocale(language)` 가 켜진 정상 팩의 사전(내장 키의 문자열만)을 돌려주고, 고른 언어가 팩 언어면 메인 `tr()` 에도 넣는다(`setMainLocalePack`). 고른 팩이 지워지거나 꺼지거나 깨지면 `settings.language` 를 기본(en)으로 되돌린다. 확장 ↔ 앱 통로(#536): `call(id, method, params, project)` 가 manifest `permissions`(network·secrets·project) 를 검사하고 storage·secrets·network.fetch·project.* 를 처리한다(던지지 않고 `{ ok, result | error }`), 허용 목록은 `allowOrigin`·`revokeOrigin`, 자료는 `data/<id>/`(삭제 때 지움). 다리(`extensionsBridge`)가 화면이 준 폴더를 등록된 프로젝트일 때만 넘긴다(inject `projects`). 대화상자는 host(`electron/extensionsHost.ts`). 생성자는 던지지 않는다 | `settings` |
| `features` | `features.ts` | **기능 레지스트리** — 켜진 기능 묶음을 올리고 내린다 (4절) | `settings` |
| `quit` | `quit.ts` | 종료 확인(도는 턴·붙은 폰이 있으면 한 번 묻는다)·창 닫기 = 숨기기(Windows·Linux 는 트레이). `remote` 는 선택 의존 | `chat`, `settings` |
| `report` | `report.ts` | 대화 내보내기(엔진 기록 → Trajectory 중립 레코드 → JSON 파일 하나)·문제 신고 묶음(고른 폴더에 `litecode-report-<시각>/`, 허용 목록 파일만, 글은 알려진 비밀 값 + `redactSecrets` 로 가림). 로컬 저장만. 대화상자·폴더 열기는 host. `mcp` 는 선택 의존(`ctx.get`) | `llm`, `sessions`, `settings`, `features`, `providers`, `engine` |

### 2-2. 기능 묶음 — 설정에서 끄면 통째로 내려간다 (`shared/features.ts`)

| 기능 id | 서비스 키 | 파일 | 하는 일 | inject | 기본 |
|---|---|---|---|---|---|
| `at` `slash` | (트리거 플러그인) | `src/triggers/at.ts` `slash.ts` | `@` 파일 포함 검색·`/` 명령 메뉴 | `triggers`, `llm` | 고정 켜짐 |
| `bang` `shell` | `shell` | `shell.ts` | `!명령` 실행 | — | 고정 켜짐 |
| `skills` | `skills` | `skills.ts` | 스킬 목록·본문 붙이기(앱 폴더·프로젝트 `.opencode/skills`) | `llm` | 고정 켜짐 |
| `mcp` | `mcp` | `mcp.ts` `mcpClient.ts` | MCP 서버 목록·편집·연결 시험·서버 안 도구 고르기 | `llm` | 고정 켜짐 |
 | `terminal` | `terminals` | `terminals.ts` | 터미널 탭, 다중 — (프로젝트, 번호)별 pty + 출력 축적, 이벤트에 번호 (#303) | `llm` | 켜짐 (고정 — 2026-10-15 부터 기능 화면에 줄 없음) |
| `trajectory` | `trajectory` | `trajectory.ts` | 추론 과정 보기 | `llm` | 켜짐 |
| `remote` | `remote` | `remote.ts`(진입점)·`remote/*`(서비스·요청 표·짝짓기 요청·chat 이벤트 옮기기, #298) | 모바일 연결 — 계약·인증·기기·짝짓기·이벤트 링 (+평문 루프백 HTTP 운반) | `chat`, `sessions`, `projects`, `providers`, `settings` | **꺼짐** |
| `lan` | — | `remote/https.ts` | 사내망 연결 — TLS 운반(설정 > 모바일의 토글, #210) | `remote` | 켜짐 (`remote` 를 켜면) |
| `bluetooth` | — | `remote/bluetooth.ts` | 블루투스 연결 — BLE 운반(설정 > 모바일의 토글, #210). 네이티브 모듈은 켤 때 읽는다 | `remote` | **꺼짐** |
| `web` | — | (엔진 설정만) | opencode webfetch 허용 | — | **꺼짐** |
| `hooks` | `hooks` | `hooks.ts` + `hooks/*` | AI 행동에 거는 사용자 셸 훅 | `chat`, `sessions`, `llm` | **꺼짐** |
| `voice` | `speech` | `speech.ts` | 음성 입력(내장 인식 엔진) | `settings` | **꺼짐** |
| `browser` | `browser` | `browser.ts` + `browser/*` | Chrome 조종(Playwright MCP 를 MCP 서버로 등록) | `mcp` | **꺼짐** |
| `updates` | `updates` | `updates.ts` (+ 순수 `shared/updates.ts`) | 새 버전 알림 — GitHub 릴리즈(또는 설정 `updateUrl`)에 묻기만, 설치본에서만(#273) | `settings` | **꺼짐** (기능 화면의 카드는 2026-10-15 부터 잠정 숨김 — 기능은 그대로) |
| `repeatGuard` | `repeatGuard` | `repeatGuard.ts` (+ 순수 `repeatCounter.ts`) | 같은 도구·같은 인자 연속 3·5·8번째로 실행에 들어갈 때(`llm/tool-started`) 모델에게만 한 줄(`ctx.llm.remind`, 합성 글) — 막지 않는다(#284) | `llm` | 켜짐 |
| `git` | `git` | `git.ts` + `appMcp/tools/git.ts` (+ 모양 `shared/git.ts`) | 시스템 git(인자 배열, 인증 창 없음) — 상태·diff·기록·브랜치·stage·커밋·전환·push/pull(충돌이면 멈춤)·되돌리기·실행 취소. 바꾸면 `git/changed`. AI 도구 `litecode_git_*`(읽기 넷 바로, 쓰기 여섯 승인 카드)는 `appMcp` 가 켜져 있을 때만 뜬다(#290) | — (도구는 `appMcp`) | **꺼짐** |

- `FEATURE_REQUIRES`: `bang → shell`, `appMcp → mcp`, `browser → mcp`, `lan → remote`, `bluetooth → remote` (필요한 기능이 꺼지면 같이 못 뜬다).
- `skills`·`web`·`appMcp`·`browser` 는 **엔진 설정에도 영향**이 있다 — `features/changed` 를 `ctx.engine` 이 듣고 설정을 다시 쓰고 엔진을 재시작한다(도는 턴은 끊긴다).

### 2-3. 하위 플러그인 — 자기 `ctx` 키가 없다

| 플러그인 | 위치 | 기대는 서비스 | 하는 일 |
|---|---|---|---|
| `RemoteHttp` · `RemoteHttps` | `remote/http.ts` `https.ts` | `remote` | 모바일 요청을 받는 **운반**. 리스너를 열고 `ctx.remote.carrier(…)` 로 자신을 올린다. `RemoteHttps` 는 기능 `lan` 의 묶음 |
| `RemoteBluetooth` | `remote/bluetooth.ts` | `remote` | 같은 자리의 BLE 운반(기능 `bluetooth` 의 묶음, #210) — 광고하고, 폰 연결마다 Noise NK → `serveFramed` → `ctx.remote.handle` |
| `OpenTool` · `PresentTool` · `SessionTools` · `ConversationTools` · `MakeTools` · `TaskTools` · `GitTools` | `appMcp/tools/*` | `appMcp` (+`chat` `llm` `sessions` …) | 앱 MCP 서버에 도구를 등록(effect) |
| `AtTrigger` · `SlashTrigger` | `src/triggers/*` | `triggers`, `llm` | 트리거를 등록소에 등록(effect). 하나를 내리면 그 문자는 평범한 글자 |
| `*Bridge` (chatBridge 등) | `electron/main.ts` | 각 서비스 | 서비스 ↔ **IPC** 연결 (5절) |

## 3. 의존 그림

```
settings ──────────────┬────────────► features ─► (기능 묶음을 올리고 내림)
                       ├────────────► quit(+chat) · notifications(+sessions,projects) · speech · extensions
providers ─► engine ─► llm ─┬─► sessions ─► chat ─┬─► attachments
                            │                      ├─► remote ─► RemoteHttp/Https/Bluetooth (운반)
                            │                      ├─► hooks (+sessions, llm)
                            │                      └─► quit
                            ├─► skills · mcp · terminals · trajectory
                            └─► (at/slash 트리거는 triggers + llm)
mcp ─► appMcp ─► OpenTool · PresentTool · SessionTools · MakeTools · GitTools(+git)
mcp ─► browser
projects ─► openIn
```

화살표는 "왼쪽이 떠야 오른쪽이 뜬다" (inject). 가장 아래 뿌리는 `settings`·`providers`·`projects`·`triggers` 넷이다.

## 4. 기능 레지스트리 (`ctx.features`)

- 묶음이 무엇인지는 레지스트리가 모른다. `electron/main.ts` 가 `{ id, plugin(ctx), service? }[]` 를 넘기고, 레지스트리는 `settings.features` 를 보고 `ctx.plugin(plugin)` 으로 올리고 `fiber.dispose()` 로 내린다 → **Electron 없이 단위 테스트한다.**
- **재시작 없이** 켜고 끈다. 묶음 안 IPC 핸들러·이벤트 구독이 effect 라서 내릴 때 같이 걷힌다.
- 올리고 내리기는 **한 줄(큐)** 로 선다 — 끄자마자 다시 켜도 옛 핸들러가 다 걷힌 뒤 새로 건다(`ipcMain.handle` 은 같은 채널 두 번을 거절한다). 한 묶음이 못 떠도 나머지와 `features/changed` 는 간다.
- 기본값: `shared/features.ts` — 설정 파일에는 **기본과 다른 값만** 남는다. 고정(`FIXED`)은 저장 값이 있어도 이긴다.
- `services()` 는 켜진 묶음의 서비스 키 목록 — 부팅 진단이 쓴다.
- **기능 상태**(#224) — `status(id)`·`statuses()`: 켜진 기능마다 `mounting`·`on`·`failed(reason)`, 꺼진 기능은 상태 없음. 묶음 **아래 어느 fiber** 가 던져도 그 기능의 `failed` 다(묶음이 안에서 `ctx.plugin(Service)` 를 하면 안쪽 실패가 바깥 fiber 로 안 올라온다 — cordis 4 실측, 그래서 `internal/status` 의 FAILED fiber 를 위로 따라가 묶음을 찾는다). 사유는 `failureReason` — 첫 줄만·홈 경로 `~`·`redactSecrets`·160자 상한. 묶음이 스스로 알리는 길은 `problem(id, reason | undefined)`(글 또는 `{ key, vars }` 문구 키, 꺼진 기능의 알림은 버린다) — 지금 블루투스(라디오 꺼짐·권한·미지원·실패)와 음성(엔진·모델 파일 없음/손상)이 쓴다(`electron/main.ts` `bluetoothProblems`·`speechProblems`). 끄면 사유·문제를 지우고, 다시 켜면 다시 올린다.

## 5. IPC 연결 — 브리지 패턴

서비스는 IPC 를 모른다. `electron/main.ts` 안의 **브리지 플러그인**이 서비스를 채널에 연결한다.

```ts
function chatBridge(ctx: Context) {            // 서비스를 부르는 쪽
  handle(ctx, Channel.CHAT_SEND, (_e, req) => ctx.chat.send(req))
  ctx.on('chat/turn-progress', (data) => broadcast(Channel.…, data))   // 이벤트를 화면으로
}
chatBridge.inject = ['chat']                    // chat 이 뜰 때까지 기다린다

function handle(ctx, channel, listener) {       // 되돌릴 수 있게 건다
  ctx.effect(() => { ipcMain.handle(channel, listener); return () => ipcMain.removeHandler(channel) })
}
```

- 모든 등록이 effect 라서 의존 서비스가 다시 올라와 브리지가 다시 돌아도 "이미 등록된 핸들러" 오류가 없다.
- 기능 묶음의 브리지는 그 묶음 플러그인 안에서 서비스와 **같이** 올린다 — 끄면 채널도 같이 사라진다("No handler registered" 가 뜨면 켜진 줄 알고 부른 것).
- 화면(renderer)은 서비스를 직접 부르지 않는다: `preload.cts` 가 채널을 노출하고, 이벤트는 메인이 `webContents.send` 로 알린다. 모바일은 같은 서비스(`chat` 등)를 `ctx.remote` 를 거쳐 쓴다 — **화면이 둘이어도 턴은 하나다.**

## 6. 이벤트 (Cordis `Events`)

| 서비스 | 이벤트 | 뜻 |
|---|---|---|
| `llm` | `llm/turn-started` · `llm/turn-ended`(done/failed/interrupted) | 엔진이 받아들인 턴이 시작·끝 (정확히 한 번) |
| | `llm/attention` · `llm/attention-resolved` | 승인·질문 카드가 생김·풀림 |
| | `llm/before-turn` · `llm/pre-tool` · `llm/tool-started` · `llm/tool-done` · `llm/attention-input` | **훅 자리** — 턴 전 · 도구 실행 전(결정 반환 가능) · 도구 실행 시작(running, #284) · 도구 끝 · 승인 입력 보정 |
| `chat` | `chat/turn-started` `turn-progress` `turn-attention` `turn-ended` `queue-changed` `conversations-changed` | 화면·모바일이 받는 대화 이벤트 (`shared/chat.ts` `ChatEventMap` 과 같은 모양) |
| | `chat/before-send` · `chat/after-turn` · `chat/attachments-read` | 보내기 전 · 턴 뒤 처리(훅이 듣는다) · 첨부 읽음 |
| | `chat/tasks-changed` | 그 대화의 백그라운드 하위 작업 목록(#319, `backgroundTasks.ts`) — 화면 작업 줄. 모바일엔 안 간다 |
| `sessions` | `sessions/removed` | 대화 삭제 |
| `projects` | `projects/removed` | 프로젝트 제거 |
| `settings` | `settings/changed` | 설정 변경 → 테마·기능 레지스트리·엔진이 듣는다 |
| `providers` | `providers/changed` | provider 변경 → 엔진 설정 갱신 |
| `features` | `features/changed` | 켜진 묶음을 다 올리고 내린 **뒤** — 엔진이 듣고 재시작 |
| `engine` | `engine/restart-wanted` | 설정 변경으로 다시 띄워야 한다(bail) — `llm` 이 맡아 도는 턴이 다 끝난 뒤 다시 띄운다(#632). 아무도 안 맡으면 엔진이 바로 |
| | `features/status` | 기능 상태(`FeatureStatuses` — 켜진 기능만)가 바뀌었다(#224) — 화면(설정 > 기능)이 `features:statuses-changed` 로 받는다 |
| `extensions` | `extensions/changed` | 확장 목록(`ExtensionSummary[]`)이 바뀌었다 — 설치·업그레이드·삭제·켜기/끄기·상태. 같은 값이면 다시 내지 않는다. 화면이 `extensions:changed` 로 받는다 |
| `git` | `git/changed` | 그 폴더의 저장소가 바뀌었을 수 있다(화면·AI 의 작업 뒤) — 화면이 `git:changed` 로 받아 다시 읽는다 |
| `remote` | `remote/changed` | 모바일 연결 상태 |
| `speech` · `notifications` | `speech/changed` · `notifications/changed` `toast` `open` | 상태·토스트 |
| `shell` · `terminals` | `shell/data` · `terminal/data` `terminal/exit` | 출력 조각 |

규칙: **엔진에서 오는 사실은 `llm/*`, 화면이 볼 대화 상태는 `chat/*`.** 위층(알림·훅)은 `llm/*` 를 듣고, 화면·모바일은 `chat/*` 를 듣는다.

## 7. 부팅과 함정

부팅 순서(`electron/main.ts`): `settings` → `providers` → `engine` → `llm` → `projects` → `sessions` → `triggers` → `bootstrap`(providers·llm·projects·engine·sessions·triggers·settings·features 를 inject) → `chat`·`attachments`·`report`·`extensions`(보류 적용 → 읽기 → 켜진 확장 올림)·`quit` → `features`(기능 묶음 올림). 실제 순서는 inject 가 정하고, 위 줄은 읽기 쉬운 순서일 뿐이다.

실측으로 잡은 함정 (CLAUDE.md 와 같다):
1. 서비스는 **비동기로 마운트된다** — `ctx.plugin(X)` 바로 다음 줄에서 `ctx.x` 를 쓰면 안 된다. `inject` 를 선언한 플러그인 안에서만 접근한다.
2. cordis 4.0.0-rc.10 + `moduleResolution: NodeNext` 에서 tsc 가 `Context`/`Service` 를 값으로 못 찾는다 → `moduleResolution: bundler`. cordis 는 **정확한 버전으로 고정**.
3. **서비스 생성자가 던지면 그 서비스는 영영 안 뜨고, 그것을 inject 한 쪽이 말없이 기다린다.** 생성자에서 읽는 파일은 `readJsonFileSync(file, shape)` — 모양이 다르면 `<이름>.corrupt-<시각>` 으로 옮기고 기본값.
4. preload 는 항상 `require()` 라 `electron/preload.cts`(CJS)로 따로 둔다.

부팅 진단: 15초 안에 안 뜬 서비스(바탕 inject 목록 + 켜진 기능의 서비스)를 로그(`userData/logs/main.log`)와 대화상자로 알린다. Cordis 가 잡은 오류·경고는 `[cordis]` 줄로 같은 로그에 남는다.

## 8. 운반 플러그인 — `ctx.remote` 밑

`ctx.remote` 가 **서비스**(계약·인증·기기·짝짓기·이벤트 링)이고, HTTP·TLS·블루투스는 그 밑의 **운반 플러그인**이다. 소비자가 없는 것에 `ctx.<키>` 를 주면 경계만 늘기 때문에 서비스로 만들지 않았다.

- 운반이 `ctx.remote` 에 하는 일은 둘: `ctx.remote.carrier({ id, status })` 로 자신을 올리고(effect — 설정 화면이 상태를 읽는 길), 받은 요청을 `ctx.remote.handle(RemoteRequest, RemotePeer, exchange)` 에 넘긴다.
- 요청·응답은 **운반 중립 타입**(`remote/carrier.ts`) — `http` 도 블루투스도 없다. 이벤트 스트림은 `RemoteStreamSink`(`write` 가 `false` 면 밀림 → 그동안 쌓이는 것을 합친다).
- 토글 = 플러그인 올리기/내리기 → 포트 닫기·광고 멈춤이 fiber dispose 로 정리된다. 네이티브 모듈(블루투스) 로드 실패가 `ctx.remote`·HTTP 를 건드리지 않는다.
- 길마다 토글이 따로다 (#210): `remote`(서비스 + 루프백 HTTP) 아래 `lan`(TLS)·`bluetooth`(BLE) 가 각각 기능 묶음이다. 설정 > 모바일의 두 토글이 이 두 기능 값을 바꾼다.
- 라디오 운반의 상태(꺼짐·권한 없음 등)는 `status().error`(리스너 못 뜸)가 아니라 `status().radio` 에 둔다 — `ctx.remote.status().bluetooth` 로 화면에 간다. 기기마다 지금 운반은 `devices[].via`(붙은 스트림의 운반, 없으면 이 실행의 마지막 요청).
- 블루투스 운반 (`remote/bluetooth.ts`): `load()`(앱은 `import('@stoprocent/bleno')`)를 **start 때 처음** 부르고, `ctx.remote.noiseIdentity()` 도 그때 처음 부른다 — 이 운반이 올라와 있고 키를 읽어 둔 때만 짝짓기 응답·QR·`hello` 에 `bluetoothKey`/`bk` 가 실린다. 사내망(TLS) 경로가 없으면 QR 은 `a`·`fp` 없는 블루투스 단독 QR 이다(#229). 광고는 서비스 UUID 하나(이름 없음), 폰 2대·핸드셰이크 10초. bleno 의 notify 신호는 Linux 만 → Mac·Windows 는 속도 상한(`BLUETOOTH_PACE_BYTES_PER_SECOND`, 실측 전 값)이 되밀림이다. macOS 는 끊김 신호·끊기가 없다 — tx 구독 해제를 끊김으로 보고, 우리가 끊은 연결은 구독 해제까지 쓰기를 무시한다.

## 9. 새 서비스를 더할 때

1. `src/services/<이름>.ts` — `class X extends Service`, `static readonly inject = [...]`, `super(ctx, '키')`, 파일 안에 `declare module 'cordis'` 로 `Context.키`·`Events` 타입.
2. 파일·시스템 호출은 **설정 값(host)** 으로 받는다. 서비스 안에서 `electron` 을 import 하지 않는다.
3. 생성자에서 읽는 파일은 `readJsonFileSync` (모양 검증 + 깨지면 옮기기).
4. 끌 수 있는 기능이면 `shared/features.ts`(id·기본값·`FEATURE_REQUIRES`·그룹) + `electron/main.ts` 의 기능 정의(`{ id, service, plugin }` — 서비스와 브리지를 **같은 플러그인 안**에서 올린다) + 설정 > 기능 카드 글(`feature.<id>`).
5. IPC 가 필요하면 브리지(`xBridge.inject = ['키']`) + `handle(ctx, 채널, …)`. 이벤트는 `broadcast` 로 화면에.
6. 단위 테스트: `new Context()` 에 서비스만 올려 돌린다 — Electron·opencode 없이.
7. 켜진 서비스가 부팅 진단 목록에 들어가는지 확인(기능 묶음은 `service` 필드로).
8. 이 문서 2절 표에 한 줄, `docs/status.md` 에 상세 한 줄.

## 10. 어디를 보면 되나

| 알고 싶은 것 | 파일 |
|---|---|
| 서비스를 올리는 순서·IPC 연결 | `electron/main.ts` (`bootstrap`, `*Bridge`, 기능 정의) |
| 기능 켜기/끄기 규칙 | `shared/features.ts`, `src/services/features.ts` |
| 엔진 설정 생성·권한 규칙 | `src/services/engineConfig.ts` (`MCP_TOOL_RULES`, `withBrowserRules`), `shared/modes.ts` |
| 대화 이벤트 모양 | `shared/chat.ts` (`ChatEventMap`), `shared/contract.ts` |
| 모바일 운반 | `src/services/remote.ts`(진입점), `remote/service.ts`, `remote/carrier.ts`, `shared/remote*.ts` |
| Cordis 사용법(참고) | dsh `docs/cordis-primer.md`, `docs/cordis-tutorial/` |
