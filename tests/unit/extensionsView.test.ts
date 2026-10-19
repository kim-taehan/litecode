import { describe, expect, it } from 'vitest'
import { translate, type Language, type MessageKey } from '../../shared/i18n/index.ts'
import type { ExtensionFailedReason, ExtensionPreview, ExtensionProblem, ExtensionStoreFailure, ExtensionSummary, UnsafePathReason } from '../../shared/extensions.ts'
import {
  cardKind,
  compareVersions,
  failedReasonText,
  failureLines,
  filterExtensions,
  formatBytes,
  installKind,
  problemLine,
  type Message,
  type ProblemLine,
} from '../../renderer/extensionsView.ts'

// 설정 > 기능의 확장 카드·설치 확인·거절 (이슈 #489) — 순수 규칙. 사유 코드는 메인이 코드 + 변수로 보내고 문구는 화면이 입힌다

/** 사유 코드마다 하나 — 코드가 늘면 이 표가 타입 검사에서 빠짐을 잡는다 */
const PROBLEMS: { [C in ExtensionProblem['code']]: Extract<ExtensionProblem, { code: C }> } = {
  'zip-unreadable': { code: 'zip-unreadable', params: { message: 'bad zip' } },
  'zip-too-large': { code: 'zip-too-large', params: { bytes: 30 * 1024 * 1024, limit: 20 * 1024 * 1024 } },
  'too-many-entries': { code: 'too-many-entries', params: { count: 5000, limit: 2000 } },
  'total-too-large': { code: 'total-too-large', params: { bytes: 300 * 1024 * 1024, limit: 100 * 1024 * 1024 } },
  'file-too-large': { code: 'file-too-large', params: { path: 'big.bin', bytes: 60 * 1024 * 1024, limit: 50 * 1024 * 1024 } },
  'unsafe-path': { code: 'unsafe-path', params: { path: '../../config/secret.json', reason: 'parent' } },
  symlink: { code: 'symlink', params: { path: 'link' } },
  'duplicate-path': { code: 'duplicate-path', params: { path: 'a.js' } },
  'manifest-missing': { code: 'manifest-missing', params: {} },
  'manifest-ambiguous': { code: 'manifest-ambiguous', params: { paths: 'a/extension.json, b/extension.json' } },
  'manifest-misplaced': { code: 'manifest-misplaced', params: { path: 'a/b/extension.json' } },
  'manifest-too-large': { code: 'manifest-too-large', params: { bytes: 2 * 1024 * 1024, limit: 64 * 1024 } },
  'manifest-invalid': { code: 'manifest-invalid', params: { message: 'Unexpected token' } },
  'field-missing': { code: 'field-missing', params: { field: 'entry' } },
  'field-unknown': { code: 'field-unknown', params: { field: 'permisions', suggestion: 'permissions' } },
  'id-invalid': { code: 'id-invalid', params: { value: 'Bad_Id' } },
  'id-reserved': { code: 'id-reserved', params: { value: 'git' } },
  'text-invalid': { code: 'text-invalid', params: { field: 'name', max: 60 } },
  'version-invalid': { code: 'version-invalid', params: { field: 'version', value: '1.0' } },
  'app-too-old': { code: 'app-too-old', params: { required: '9.0.0', current: '0.4.0' } },
  'entry-invalid': { code: 'entry-invalid', params: { value: '../index.js' } },
  'permissions-invalid': { code: 'permissions-invalid', params: {} },
  'entry-missing': { code: 'entry-missing', params: { entry: 'index.js' } },
  'id-mismatch': { code: 'id-mismatch', params: { folder: 'old-name', id: 'new-name' } },
}

const FAILURES: { [C in ExtensionStoreFailure['code']]: Extract<ExtensionStoreFailure, { code: C }> } = {
  'token-unknown': { code: 'token-unknown', params: {} },
  rejected: { code: 'rejected', params: { problems: [PROBLEMS['entry-missing'], PROBLEMS.symlink] } },
  'staged-mismatch': { code: 'staged-mismatch', params: { expected: 'a@1.0.0', actual: 'a@2.0.0' } },
  'unpack-failed': { code: 'unpack-failed', params: { message: 'EACCES' } },
  'verify-failed': { code: 'verify-failed', params: { message: 'hash' } },
  'id-invalid': { code: 'id-invalid', params: { value: 'X' } },
  'not-installed': { code: 'not-installed', params: { id: 'gone' } },
  'io-failed': { code: 'io-failed', params: { message: 'disk full' } },
  'apply-failed': { code: 'apply-failed', params: { message: 'EACCES' } },
  'not-on': { code: 'not-on', params: { id: 'off-ext' } },
  'entry-not-html': { code: 'entry-not-html', params: { entry: 'index.js' } },
  'entry-unsafe': { code: 'entry-unsafe', params: { entry: 'index.html' } },
  'entry-too-large': { code: 'entry-too-large', params: { bytes: 3 * 1024 * 1024, limit: 2 * 1024 * 1024 } },
  'entry-unreadable': { code: 'entry-unreadable', params: { message: 'ENOENT' } },
}

const UNSAFE: Record<UnsafePathReason, true> = { empty: true, nul: true, absolute: true, drive: true, backslash: true, parent: true }

const LANGUAGES: Language[] = ['ko', 'en']
const say = (language: Language, message: Message) => translate(language, message.key, message.vars)

/** 줄의 모든 문구가 두 언어에서 비지 않고 자리표시자가 남지 않았나 */
function expectWellFormed(line: ProblemLine): void {
  for (const language of LANGUAGES) {
    for (const message of [line.title, line.detail].filter((m): m is Message => m !== undefined)) {
      const text = say(language, message)
      expect(text.trim()).not.toBe('')
      expect(text).not.toMatch(/\{\w+\}/)
    }
  }
}

describe('problemLine — 거절 사유 코드 전부가 문구를 가진다', () => {
  for (const problem of Object.values(PROBLEMS)) {
    it(`${problem.code} → 자기 제목 키 + 변수가 다 채워진다`, () => {
      const line = problemLine(problem)
      expect(line.title.key).toBe(`extensions.problem.${problem.code}`)
      expectWellFormed(line)
    })
  }

  it('위험한 경로의 종류마다 보조 글이 있다 (경로는 고정폭)', () => {
    for (const reason of Object.keys(UNSAFE) as UnsafePathReason[]) {
      const line = problemLine({ code: 'unsafe-path', params: { path: 'x', reason } })
      expect(line.detail?.key).toBe(`extensions.unsafePath.${reason}`)
      expect(line.mono).toBe('x')
      expectWellFormed(line)
    }
  })

  it('field-unknown 은 suggestion 이 있으면 "혹시 X 인가요?", 없으면 보조 글 없음', () => {
    const withHint = problemLine(PROBLEMS['field-unknown'])
    expect(withHint.mono).toBe('permisions')
    expect(say('ko', withHint.detail!)).toBe('혹시 permissions 인가요?')
    const bare = problemLine({ code: 'field-unknown', params: { field: 'zzz' } })
    expect(bare.detail).toBeUndefined()
  })

  it('크기 사유는 사람이 읽는 단위로', () => {
    expect(say('ko', problemLine(PROBLEMS['zip-too-large']).detail!)).toBe('30 MB — 최대 20 MB')
  })

  it('원문 메시지(오류)는 번역하지 않고 plain 으로', () => {
    expect(problemLine(PROBLEMS['zip-unreadable']).plain).toBe('bad zip')
    expect(problemLine(PROBLEMS['manifest-invalid']).plain).toBe('Unexpected token')
  })

  it('모르는 코드는 던지지 않고 일반 문구 + 코드 원문', () => {
    const line = problemLine({ code: 'from-the-future', params: {} } as unknown as ExtensionProblem)
    expect(line.title.key).toBe('extensions.problem.unknown')
    expect(line.mono).toBe('from-the-future')
    expectWellFormed(line)
  })

  it('모르는 위험 경로 종류도 일반 문구', () => {
    const line = problemLine({ code: 'unsafe-path', params: { path: 'x', reason: 'weird' as UnsafePathReason } })
    expect(line.detail).toBeUndefined()
    expectWellFormed(line)
  })
})

describe('failureLines — 설치·삭제 실패 코드 전부가 문구를 가진다', () => {
  for (const failure of Object.values(FAILURES)) {
    it(`${failure.code}`, () => {
      const lines = failureLines(failure)
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) expectWellFormed(line)
      if (failure.code !== 'rejected') expect(lines[0]!.title.key).toBe(`extensions.failure.${failure.code}`)
    })
  }

  it('rejected 는 다시 검사한 사유들을 그대로 펼친다', () => {
    const lines = failureLines(FAILURES.rejected)
    expect(lines.map((line) => line.title.key)).toEqual(['extensions.problem.entry-missing', 'extensions.problem.symlink'])
  })

  it('rejected 인데 사유가 비면 제목 한 줄', () => {
    expect(failureLines({ code: 'rejected', params: { problems: [] } }).map((line) => line.title.key)).toEqual(['extensions.failure.rejected'])
  })

  it('모르는 실패 코드는 일반 문구', () => {
    const lines = failureLines({ code: 'nope', params: {} } as unknown as ExtensionStoreFailure)
    expect(lines.map((line) => line.title.key)).toEqual(['extensions.failure.unknown'])
  })
})

describe('failedReasonText — 카드의 빨간 사유 한 줄', () => {
  const t = (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars)

  it('invalid = "설치 폴더가 올바르지 않음 — " + 첫 사유 요약', () => {
    const reason: ExtensionFailedReason = { code: 'invalid', params: { problems: [PROBLEMS['entry-missing'], PROBLEMS.symlink] } }
    expect(failedReasonText(reason, t)).toBe('설치 폴더가 올바르지 않음 — 진입 파일이 없습니다 (index.js)')
  })

  it('invalid 인데 사유가 없으면 앞말만', () => {
    expect(failedReasonText({ code: 'invalid', params: { problems: [] } }, t)).toBe('설치 폴더가 올바르지 않음')
  })

  it('mount-failed = "올리지 못함 — " + message', () => {
    expect(failedReasonText({ code: 'mount-failed', params: { message: 'boom' } }, t)).toBe('올리지 못함 — boom')
  })

  it('모르는 사유는 "올리지 못함"', () => {
    expect(failedReasonText({ code: 'later', params: {} } as unknown as ExtensionFailedReason, t)).toBe('올리지 못함')
  })
})

describe('formatBytes — 사람이 읽는 단위 (1024 진법)', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [84 * 1024, '84 KB'],
    [10.4 * 1024, '10 KB'],
    [2.34 * 1024 * 1024, '2.3 MB'],
    [3 * 1024 * 1024 * 1024, '3 GB'],
  ])('%d → %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text)
  })
})

describe('compareVersions — semver 2.0.0 순서 (서비스 manifest.ts 와 같은 규칙)', () => {
  it.each([
    ['1.2.0', '1.1.0', 1],
    ['1.1.0', '1.2.0', -1],
    ['1.2.0', '1.2.0', 0],
    ['2.0.0', '10.0.0', -1],
    ['1.0.0', '1.0.0-beta', 1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1],
    ['1.0.0-rc.1', '1.0.0-beta', 1],
    ['1.0.0+build.1', '1.0.0+build.2', 0],
  ])('%s vs %s → %d 부호', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign)
  })
})

describe('installKind — 신규·업그레이드·같은 버전·이전 버전', () => {
  const preview = (version: string, existing?: string): ExtensionPreview => ({
    manifest: { id: 'a-b', name: 'A', description: 'd', version, entry: 'index.js' },
    files: { count: 1, totalBytes: 1 },
    problems: [],
    token: 't',
    ...(existing ? { existing: { version: existing } } : {}),
  })
  it('existing 이 없으면 new', () => expect(installKind(preview('1.0.0'))).toBe('new'))
  it('새 버전이 크면 upgrade', () => expect(installKind(preview('1.2.0', '1.1.0'))).toBe('upgrade'))
  it('같으면 same', () => expect(installKind(preview('1.2.0', '1.2.0'))).toBe('same'))
  it('작으면 downgrade', () => expect(installKind(preview('1.0.0', '1.0.1'))).toBe('downgrade'))
  it('정식 < 프리릴리스 아님 — 1.0.0-beta → 1.0.0 은 upgrade', () => expect(installKind(preview('1.0.0', '1.0.0-beta'))).toBe('upgrade'))
})

const ext = (patch: Partial<ExtensionSummary> & { id: string }): ExtensionSummary => ({ enabled: true, state: 'on', ...patch })

describe('cardKind — 카드 상태 표현 (실패 > 올리는 중 > 켜짐/꺼짐, 보류 상태는 없다 — 이슈 #511)', () => {
  it('on / off', () => {
    expect(cardKind(ext({ id: 'a' }))).toBe('on')
    expect(cardKind(ext({ id: 'a', enabled: false, state: 'off' }))).toBe('off')
  })
  it('mounting · failed', () => {
    expect(cardKind(ext({ id: 'a', state: 'mounting' }))).toBe('mounting')
    expect(cardKind(ext({ id: 'a', state: 'failed', reason: { code: 'mount-failed', params: { message: 'x' } } }))).toBe('failed')
  })
})

describe('filterExtensions — id 순 + 찾기(이름·설명·id, 대소문자 무시)', () => {
  const list = [
    ext({ id: 'zeta', name: '로그 분석기', description: '서버 로그를 훑습니다' }),
    ext({ id: 'alpha', name: 'Code Review', description: 'PR 체크리스트' }),
    ext({ id: 'broken' }),
  ]
  it('빈 말이면 전부, id 순', () => {
    expect(filterExtensions(list, '  ').map((e) => e.id)).toEqual(['alpha', 'broken', 'zeta'])
  })
  it('이름으로', () => expect(filterExtensions(list, 'review').map((e) => e.id)).toEqual(['alpha']))
  it('설명으로', () => expect(filterExtensions(list, '로그를').map((e) => e.id)).toEqual(['zeta']))
  it('이름 없는(깨진) 확장은 id 로', () => expect(filterExtensions(list, 'BROK').map((e) => e.id)).toEqual(['broken']))
  it('원본 배열을 바꾸지 않는다', () => {
    filterExtensions(list, '')
    expect(list.map((e) => e.id)).toEqual(['zeta', 'alpha', 'broken'])
  })
})
