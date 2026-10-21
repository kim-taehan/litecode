# AGENTS.md — 수정 워크 플로우

이슈·피드백이 코드 수정으로 착지할 때 지키는 컨벤션. 이름은 기존 수정 이력(2026-10)에서 따온 것.

## 순서 (이슈 먼저)

1. **GitHub issue 를 먼저 만든다** — 이슈 없이는 브랜치도, 수정도 없다.
   `gh issue create` (제목 = 문제 한 줄, 본문 = 사용자 원문 보고 + 기대 동작)
2. **이슈 번호가 들어가는 브랜치를 `dev` 에서 만든다:**

   | 종류 | 형태 | 이력 예 |
   |---|---|---|
   | 기능·동작 변경 | `feat_<issue>_<짧은_snake>` | `feat_325_task_detail` · `feat_305_project_quick_open` |
   | 버그 수정 | `fix_<issue>_<짧은_snake>` | `fix_231_keystore_error` · `fix_314_features_one_col` |
   | 리팩터·문서 | `refactor_<issue>_…` · `docs_<issue>_…` | `refactor_182_llm_chat_history` · `docs_173_cordis_services` |

   (최초 이력은 `feat/17-file-preview` 슬래시 모양 — 지금은 밑줄 모양이 정형)
3. **수정 완료**: `npm run typecheck` + `npm test` 초록.
   `docs/feedback.md` 엔트리라면 `Status: done (YYYY-MM-DD)` + `Fix:` 한 줄, 기능줄이 바뀌면 `docs/status.md` 도 같이.
4. **PR → `dev`** — 제목(=스쿼시 커밋) 은 영어로 `<Area>: <summary> (#<issue>)`:
   - `Background task detail tab in the right panel (#325)`
   - `Terminal: move to right panel tabs, multiple terminals, new shortcuts (#309)`

   `(#<issue>)` 는 이슈를 가리킨다(머지 시 이슈 자동 닫힘).
