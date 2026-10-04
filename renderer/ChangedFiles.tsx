import { memo, useState } from 'react'
import { CHANGED_FILES_FOLD, splitPath, type ChangedFile, type TurnChanges } from './changedFiles.ts'
import { DiffCard } from './DiffCard.tsx'
import { openFilePreview } from './filePreviewStore.ts'
import { useT } from './settingsStore.ts'
import './changedFiles.css'

// 턴 끝 "AI 가 고친 파일" 카드 (이슈 #82, dsh ui-deliverables ChangedFiles 참조 — 답과 행동 줄 사이의 카드 한 장이라는 자리·줄 모양만):
// 머리 "AI 가 고친 파일 N · +a −d", 줄마다 이름(폴더는 흐리게)·상태·+a −d·횟수. 줄을 누르면 그 파일의 diff 가 카드 안에서 펼쳐지고
// (DiffCard — 여러 번 고쳤으면 순서대로), 이름 옆 버튼은 오른쪽 패널에서 그 파일을 연다(답의 파일 칩과 같은 길).
// 모은 규칙과 한계는 changedFiles.ts — 명령으로 바꾼 파일은 빠지므로 카드 아래 줄이 그렇다고 말한다.
// 대화 안 찾기(ChatFind)의 대상이 아니다: 같은 diff 가 작업 줄(.turn__work)에 이미 있어 여기까지 찾으면 일치가 두 번 센다

const stat = (added: number, removed: number, unknownBefore: boolean) => `+${added} −${unknownBefore ? '?' : removed}`

export const ChangedFilesCard = memo(function ChangedFilesCard({ changes, directory }: { changes: TurnChanges; directory: string }) {
  const t = useT()
  const [all, setAll] = useState(false)
  const files = all ? changes.files : changes.files.slice(0, CHANGED_FILES_FOLD)
  const more = changes.files.length - files.length
  return (
    <section className="changed-files" aria-label={t('changes.title', { count: changes.files.length })}>
      <div className="changed-files__head">
        <span className="changed-files__title">{t('changes.title', { count: changes.files.length })}</span>
        <span className="changed-files__stat">{stat(changes.added, changes.removed, changes.unknownBefore)}</span>
      </div>
      <ul className="changed-files__list">
        {files.map((file) => (
          <FileRow key={file.path} file={file} directory={directory} />
        ))}
      </ul>
      {more > 0 && (
        <button type="button" className="changed-files__more" onClick={() => setAll(true)}>
          {t('changes.more', { count: more })}
        </button>
      )}
      <p className="changed-files__note">{t('changes.note')}</p>
    </section>
  )
})

function FileRow({ file, directory }: { file: ChangedFile; directory: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const { name, folder } = splitPath(file.path)
  return (
    <li className="changed-files__item" data-status={file.status}>
      <div className="changed-files__row">
        <button type="button" className="changed-files__toggle" aria-expanded={open} title={open ? t('diff.hide') : t('diff.show')} onClick={() => setOpen((now) => !now)}>
          <svg className="changed-files__chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 4L10 8L6 12" />
          </svg>
          <span className="changed-files__name">{name}</span>
          {folder && <span className="changed-files__folder">{folder}</span>}
          <span className="changed-files__status">{t(file.status === 'added' ? 'diff.added' : file.status === 'deleted' ? 'diff.deleted' : 'changes.modified')}</span>
          <span className="changed-files__spacer" />
          {file.edits > 1 && <span className="changed-files__edits">{t('changes.edits', { count: file.edits })}</span>}
          <span className="changed-files__stat">{stat(file.added, file.removed, file.unknownBefore)}</span>
        </button>
        {/* 지운 파일은 열 것이 없다 */}
        {file.status !== 'deleted' && (
          <button
            type="button"
            className="changed-files__open"
            aria-label={t('markdown.previewFile', { file: file.path })}
            title={t('markdown.previewFile', { file: file.path })}
            onClick={() => openFilePreview(directory, file.path)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 2.5H13.5V7M13.5 2.5L7.5 8.5M6 3.5H3.5V12.5H12.5V10" />
            </svg>
          </button>
        )}
      </div>
      {open && (
        <div className="changed-files__diff">
          <DiffCard diffs={file.diffs} />
        </div>
      )}
    </li>
  )
}
