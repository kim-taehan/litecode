# Third-party notices

litecode 설치본에 함께 실리는 음성 입력(받아쓰기) 엔진과 모델의 출처·라이선스다. 받는 스크립트는 `scripts/fetch-speech.mjs`
(버전·리비전·체크섬 고정), 설치본 안의 자리는 `Resources/speech/` 다. 브라우저 기능의 MCP 서버(`scripts/fetch-browser.mjs`, `Resources/browser/`)도
맨 아래에 적는다. 이 파일은 그것들만 적는다 — 다른 동봉물(opencode, ripgrep)과 npm 의존성의 고지는 아직 여기에 없다.

## sherpa-onnx (speech recognition runtime)

- 무엇: `sherpa-onnx-node` 1.13.8 과 플랫폼별 네이티브 패키지(`sherpa-onnx-darwin-arm64` · `sherpa-onnx-darwin-x64` · `sherpa-onnx-win-x64`)
- 출처: https://github.com/k2-fsa/sherpa-onnx — npm 레지스트리(`registry.npmjs.org`)에서 받는다
- 라이선스: Apache License 2.0 (각 패키지의 `package.json` `license` 필드)
- 네이티브 패키지 안에 ONNX Runtime 라이브러리(`libonnxruntime` / `onnxruntime.dll`, https://github.com/microsoft/onnxruntime, MIT License)가 들어 있다

## SenseVoiceSmall (speech recognition model)

- 무엇: SenseVoiceSmall 의 ONNX int8 판 — `model.int8.onnx`, `tokens.txt`
- 원 모델: SenseVoice (FunAudioLLM, Alibaba) — https://github.com/FunAudioLLM/SenseVoice
- 받은 곳: https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17 (리비전 `2365baeacb507f821a0c8120fcee3d484dba7a07`)
- 라이선스: FunASR Model License — https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE
  (출처와 모델 이름을 표기해야 한다. 표준 오픈소스 라이선스가 아니다 — 사내 배포 전 검토 대상, `_workspace/01ag_voice_input.md` 결정 3)

## Silero VAD (voice activity detection model)

- 무엇: `silero_vad.onnx`
- 원 모델: Silero VAD — https://github.com/snakers4/silero-vad
- 받은 곳: https://huggingface.co/csukuangfj/vad (리비전 `fba88cd2e921609e7675c3aaf51e0b9b295da4bc`)
- 라이선스: MIT License

## Playwright MCP (browser automation MCP server)

- 무엇: `@playwright/mcp` 0.0.83 — 브라우저 기능이 내장 MCP 서버로 띄운다
- 출처: https://github.com/microsoft/playwright-mcp — npm 레지스트리(`registry.npmjs.org`)에서 받는다
- 라이선스: Apache License 2.0 (패키지의 `LICENSE`)

## playwright-core (browser automation library)

- 무엇: `playwright-core` 1.64.0-alpha-1790635538000 — Playwright MCP 가 읽는다 (`types/`·`bin/`·`lib/vite/` 는 싣지 않는다). 브라우저는 싣지 않는다
- 출처: https://github.com/microsoft/playwright — npm 레지스트리(`registry.npmjs.org`)에서 받는다
- 라이선스: Apache License 2.0 (패키지의 `LICENSE`). 안에 번들된 제3자 코드의 고지는 패키지의 `ThirdPartyNotices.txt` 와
  `lib/` 의 `*.LICENSE` 파일로 함께 실린다
