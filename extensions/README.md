# extensions

설치해 쓸 수 있는 확장(한 파일 HTML)과 zip. 설정 > 기능 에서 zip 을 추가하면 설치되고, 오른쪽 패널에서 열린다.

- `tetris-demo/` — 테트리스
- `ladder-demo/` — 사다리 게임
- `zh-cn-pack/` — 간체 중국어 언어 팩 (`"type": "locale"`, 이슈 #525). 화면이 없는 종류라 패널에서 열리지 않는다 — 설치한 뒤 설정 > 일반 > 언어에서 고른다. `locale: { language, label }` 을 선언하고 `entry` 는 `{ "문구 키": "번역" }` JSON 번들(앱 사전에 있는 키만 쓰이고, 없는 키는 영어로 보인다)

zip 은 폴더 안의 `extension.json`·`index.html` 을 폴더 없이 묶은 것이다:

```bash
cd extensions/ladder-demo && zip -q ../ladder-demo.zip extension.json index.html
cd extensions/zh-cn-pack && zip -q ../zh-cn-pack.zip extension.json locale.json
```

`extension.json` 의 선택 필드 `details` 는 여러 줄 긴 설명(2000자 이하, 글로만 보인다) — 설정 > 기능 에서 확장 카드를 누르면 펼쳐진 상세에 줄바꿈 그대로 보인다.

만드는 법·manifest 규칙은 `docs/` 의 확장 문서를 본다.
