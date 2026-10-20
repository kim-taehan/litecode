# sonarqube

SonarQube 확장 — 확장에 든 SonarQube CE 를 이 기기에서 띄워 지금 프로젝트를 분석하고 결과를 오른쪽 패널에서 본다 (이슈 #537 내장 서버, #545 패널).
사내(외부) SonarQube 서버에 붙는 화면은 아직 없다.

- `extension.json` — 권한 `server`(내장 서버) · `network`(자기 서버에 요청 — 동의 없이, 인증은 앱이 붙인다) · `project`(범위 고르기·내 변경·파일 열기)
- `index.html` — 패널: 서버 띄우기·멈추기·단계, [분석](범위 전체 / 폴더·파일 / 내 변경 — 범위는 `<키>__scope` 로 따로), 품질 게이트·지표·이슈
- 프로젝트 키: 프로젝트 폴더의 `sonar-project.properties` 의 `sonar.projectKey`, 없으면 프로젝트 이름에서 만든다

## zip 만들기

서버 본체(약 800MB)는 레포에 넣지 않는다 — 망 밖에서 받아 묶는다:

```bash
node scripts/fetch-sonarqube.mjs            # build/vendor/sonarqube/<타깃>/server/ 에 받는다 (버전·sha256 고정)
mkdir -p /tmp/sq && cp extensions/sonarqube/extension.json extensions/sonarqube/index.html /tmp/sq/
cp -R build/vendor/sonarqube/mac-arm64/server /tmp/sq/server
(cd /tmp/sq && zip -qry -1 ../sonarqube-0.2.3-mac-arm64.zip .)
```

zip 은 697MB 남짓이라 git 에 넣지 않는다(`server` 권한 확장만 상한이 1GB 다). 패널만 고쳤으면 있는 zip 의 두 파일만 바꿔 넣는다:
`(cd extensions/sonarqube && zip -q ../<zip> extension.json index.html)`

## `server` — 앱이 선언대로만 띄우는 내장 서버

확장의 JS 는 메인에서 실행하지 않는다. 앱은 이 선언을 검사하고(`src/services/extensions/server.ts parseServerDeclaration`) 그대로 띄운다.

| 필드 | 뜻 |
|---|---|
| `command` | 확장 폴더 기준 실행 파일 (폴더 밖·절대 경로 불가). 셸 없이 띄운다 |
| `cwd` | 확장 폴더 기준 작업 폴더 (생략하면 확장 폴더) |
| `args` | 문자열 배열 |
| `env` | 더할 환경 변수 (선택) |
| `port` | 127.0.0.1 고정 포트 (1024~65535). 띄우기 전에 비었는지 본다 |
| `health` | 준비 판정 — `GET path` 의 JSON 에서 `field` 가 `ready` 면 준비됨 |
| `admin` | 앱이 아는 관리자 준비 이름 (`sonarqube` — 기본 비밀번호를 바꾸고 토큰을 만들어 앱이 보관) |

`args`·`env` 의 자리표시: `${extensionDir}` · `${dataDir}`(앱 데이터 폴더 아래 확장별) · `${port}` · `${freePort:이름}`(띄울 때 고른 빈 포트).

## `server/` 채우기 (망 밖에서)

```bash
node scripts/fetch-sonarqube.mjs            # build/vendor/sonarqube/<타깃>/server/{sonarqube,runtime,scanner}
```

인자들의 근거(JDK 모듈, 검색 엔진 디스크 임계값, 내장 DB 포트 등)는 `_workspace/01_probe_537.md`.
