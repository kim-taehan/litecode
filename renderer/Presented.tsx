import { memo } from 'react'
import type { PresentedFile } from '../shared/contract.ts'
import { splitPath } from './changedFiles.ts'
import { openFilePreview } from './filePreviewStore.ts'
import { useT } from './settingsStore.ts'
import './presented.css'

// 턴 끝 "결과물" 카드 (이슈 #91, dsh deliverables 의 present 카드 참조 — 답 아래 파일 줄이라는 자리와 "누르면 지금의 파일을 연다" 만):
// AI 가 결과물로 선언한 파일마다 한 줄 — 제목이 있으면 제목 + 흐린 경로, 없으면 이름 + 흐린 폴더. 줄을 누르면 오른쪽 패널에서 그 파일을 연다
// (답의 파일 칩과 같은 길 — 파일이 그 사이 지워졌거나 프로젝트 밖이 됐으면 패널이 그렇다고 말한다). 모양은 "AI 가 고친 파일" 카드(changedFiles.css)에 맞췄다.
// 모은 규칙은 presented.ts. 대화 안 찾기(ChatFind)의 대상이 아니다 (고친 파일 카드와 같다)

export const PresentedCard = memo(function PresentedCard({ files, directory }: { files: readonly PresentedFile[]; directory: string }) {
  const t = useT()
  return (
    <section className="presented" aria-label={t('present.cardTitle', { count: files.length })}>
      <div className="presented__head">{t('present.cardTitle', { count: files.length })}</div>
      <ul className="presented__list">
        {files.map((file) => {
          const { name, folder } = splitPath(file.path)
          return (
            <li key={file.path}>
              <button type="button" className="presented__row" title={t('markdown.previewFile', { file: file.path })} onClick={() => openFilePreview(directory, file.path)}>
                <svg className="presented__icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 1.75H9.5L12.5 4.75V14.25H4Z" />
                  <path d="M9.5 1.75V4.75H12.5" />
                </svg>
                <span className="presented__name">{file.title ?? name}</span>
                {(file.title ? file.path : folder) && <span className="presented__path">{file.title ? file.path : folder}</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
})
