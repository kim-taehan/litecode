# Contributing — 온보딩 가이드

이 레포에서 개발을 시작하는 사람을 위한 전제·실행·컨벤션. 제품이 뭐 하는 건지는
[README](README.md), 구조는 [`docs/architecture.md`](docs/architecture.md) 를 읽는다.

## 전제

| 것 | 버전 | 비고 |
|---|---|---|
| Node.js | 22+ (개발 머신 22.18) | npm 번들 |
| macOS / Windows | — | Windows 는 빌드만 확인, 실행 미검증 |
| opencode | 1.18.18 (PATH 에) | `test:live` 만에서 필요. dev·단위 테스트엔 안 쓴다 |
| 사내 LLM 게이트웨이 | — | 앱을 실제로 돌리려면 설정 > 모델 에서 Base URL·API 키·모델 id |

## 처음 실행

```bash
npm install
npm run dev    # vite(5174 빈 포트부터) + electron
```

앱이 뜨면 **설정 → 모델** (⌘,) 에서 게이트웨이 주소를 넣고, 프로젝트 폴더를 연다.
API 키는 safeStorage 로 암호화 저장 — 화면·디스크에 평문이 남지 않는다.

## 명령

| 명령 | 설명 |
|---|---|
| `npm run dev` | 개발 모드 (vite + electron) |
| `npm run typecheck` | 타입 체크 |
| `npm test` | 단위 테스트 (vitest, `tests/unit/`) — 네트워크·외부 프로세스 없음 |
| `npm run test:live` | 실물 테스트 — 격리 opencode + 가짜 LLM + 진짜 Electron 창 (8~9분, 요청이 있을 때만) |
| `npm run test:dist` | 설치본 스모크 — 먼저 `dist:mac` 을 돌린다 |
| `npm run dist:mac` / `dist:win` | 설치본 빌드 — opencode·ripgrep·음성 엔진을 받아(체크섬 대조) `release/` 에 만든다 |
| `npm run spike` | Electron 없이 서비스 골격만 돌려보는 최소 확인 |

## 착지 기준

- `npm run typecheck` + `npm test` 초록. 그 외(화면 확인 등)는 미확인이라고 적어 둔다.
- 실물 테스트는 흐름에 안 넣는다 — 요청이 있을 때만 돌린다 (2026-10-03 결정).
- `docs/feedback.md` 엔트리를 고치면 `Status: done (YYYY-MM-DD)` + `Fix:` 한 줄.
  기능줄이 바뀌면 `docs/status.md` 도 같이 고친다.

## 분기·PR (필수 순서)

1. **GitHub issue 를 먼저 만든다** — 이슈 없이는 브랜치도, 수정도 없다.
2. **`dev` 에서 이슈 번호가 들어가는 브랜치를 만든다:**

   | 종류 | 형태 |
   |---|---|
   | 기능·동작 변경 | `feat_<issue>_<짧은_snake>` |
   | 버그 수정 | `fix_<issue>_<짧은_snake>` |
   | 리팩터·문서 | `refactor_<issue>_…` · `docs_<issue>_…` |

3. **PR 은 `dev` 로**, 제목(=스쿼시 커밋) 은 영어로 `<Area>: <summary> (#<issue>)`
   (예: `Terminal: move to right panel tabs, multiple terminals (#309)`)
   — `(#<issue>)` 는 머지 시 이슈를 자동 닫는다.
4. **릴리스**: `dev` → `main` 머지(또는 수동) 시 CI (`release.yml`) 가 설치 파일을
   빌드해 GitHub Release 로 올린다. 버전은 최신 `v*` 태그 다음 패치.

## 문서 — 어디에 무엇을 적나

| 파일 | 독자 | 내용 |
|---|---|---|
| `README.md` | 사용자 + 개발자 | 제품 사용법, 큰 그림 아키텍처, 명령 |
| `CLAUDE.md` · `AGENTS.md` | AI 에이전트 | 세션마다 통째로 읽히는 규칙 + 포인터 — **짧게 유지** |
| `docs/architecture.md` | 개발자 | 구조 전체 (서비스 표, 부팅 순서, IPC/보안, 엔진, 모바일, 패키징, 함정) |
| `docs/cordis-services.md` | 개발자 | Cordis 서비스 목록·의존·이벤트·새 서비스 추가 순서 |
| `docs/opencode-protocol.md` | 개발자 | opencode 프로토콜 실측 기록 — 기대하는 코드를 고치기 전에 읽고, 새 실측은 여기에 더한다 |
| `docs/status.md` | 개발자 | 기능별 착지 기록 — 고치려는 기능의 줄만 읽고 (`grep -n '^| <이름>' docs/status.md`), 착지하면 그 줄을 고친다 |
| `docs/feedback.md` | 개발자 | 사용자 피드백·이슈 대장 |
| `docs/harness-history.md` | 개발자 | 에이전트 하네스 변경 이력 |

규칙:

- 기능 수정 전에는 `docs/status.md` 의 해당 줄(과, 엔진이면 `opencode-protocol.md`) 을
  먼저 읽고, 착지하면 그 줄을 갱신한다.
- 실측·미확인 목록 코드가 아니라 문서에 — `CLAUDE.md` 는 규칙과 포인터만.
- 제품 기능줄이 바뀌면 `README.md` 기능 목록과 `docs/status.md` 를 함께 고친다.

## 모바일 앱

`mobile/` 은 자체 `package.json` · 테스트를 가진 독립 워크스페이스 — 루트의
typecheck·`npm test`·electron-builder 는 `mobile/` 을 안 본다.

```bash
cd mobile && npx tsc --noEmit && npm test
```

개발은 데스크탑의 가짜 리모트(`node mobile/dev/fake-desktop.mts`, 짝짓기 코드
`DEV0DEV0DEV0`) 에 붙여 한다. 상세는 `docs/status.md` 모바일 줄.

## 보안

- API 키는 절대 커밋하지 않는다 — provider 키는 userData `provider-keys.json` 에
  safeStorage 봉인.
- **진짜 키는 opencode 에 주지 않는다** — 메인의 키 프록시가 요청에 붙여 주고,
  opencode 는 실행마다 난수 토큰만 가진다. `engine`/`llm`/`keyProxy`를 고칠 때
  이 경계를 건드리지 않는다 (architecture.md §4).
- 폐쇄망 원칙: 런타임 다운로드 0, 외부 요청 0. 네트워크를 쓰는 코드는 기능 묶음
  (`shared/features.ts`) 으로 감싸고 기본 꺼짐을 고려한다.
