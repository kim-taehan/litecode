# sonarqube (초안 — 아직 설치되지 않는다)

SonarQube 확장의 manifest 초안 (이슈 #537 1단계). `server` 필드·`server` 권한은 2단계에서 manifest 검사에 연결된다 — 그 전에는 지금 앱이
`field-unknown{server}` 로 거절한다. 패널(`index.html`)은 라운드 2. zip 은 아직 만들지 않는다.

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
