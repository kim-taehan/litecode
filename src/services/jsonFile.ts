import fs from 'node:fs'
import path from 'node:path'
import { tr } from '../i18n.ts'

// userData 의 JSON 파일 읽기 — 깨진 파일을 "없음" 으로 읽으면 다음 쓰기가 원본을 덮어 되살릴 길이 없어진다.
// 그래서 못 읽는 내용(JSON 이 아니다 · 맨 위 모양이 다르다)은 옆에 `<이름>.corrupt-<시각>` 으로 옮겨 두고 없는 것처럼 진행한다.
// 파일이 없는 것(ENOENT — 첫 실행)만 undefined. 그 밖의 읽기 실패(EACCES·EISDIR·EIO·Windows 의 EBUSY 등)는 옮기지 않고 그대로 던진다 —
// 내용이 깨진 것도, 없는 것도 아니다. "없음" 으로 보면 부르는 쪽이 빈 값 위에 고쳐 써서 원본을 덮는다(이슈 #195: 대화 목록 증발, TLS 키 교체).
// 부르는 서비스는 생성자에서 던지지 않는다(CLAUDE.md 함정 4) — 기본값으로 뜨되 그 파일에는 쓰지 않는다(unreadableFileError 로 거절).
// 쓰기도 임시 파일 + rename 이다 (writeJsonFileSync·writeJsonFile) — userData JSON 쓰기는 모두 이 둘을 쓴다. 권한(mode)은 부르는 쪽이 정한다

export type JsonShape = 'object' | 'array'

function matches(value: unknown, shape: JsonShape): boolean {
  return shape === 'array' ? Array.isArray(value) : !!value && typeof value === 'object' && !Array.isArray(value)
}

function parse(text: string, shape: JsonShape): { value: unknown } | { reason: string } {
  try {
    const value: unknown = JSON.parse(text)
    return matches(value, shape) ? { value } : { reason: `맨 위가 ${shape} 가 아니다` }
  } catch (error) {
    // JSON.parse 의 사유에는 원문 조각이 실린다(비밀 파일일 수 있다) — 종류만 남긴다
    return { reason: (error as Error).name }
  }
}

function backupName(file: string, now: Date): string {
  return `${file}.corrupt-${now.toISOString().replace(/[:.]/g, '-')}` // Windows 파일 이름에 `:` 를 못 쓴다
}

function report(file: string, backup: string | undefined, reason: string): void {
  console.warn(`[jsonFile] 깨진 설정 파일 ${path.basename(file)} (${reason}) — ${backup ? `${path.basename(backup)} 로 옮겨 두고` : '옮기지 못한 채'} 빈 값으로 진행한다`)
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/** 못 읽은 파일에 쓰려 할 때 던질 오류 — 화면에 그대로 보인다. 원래 오류의 code(EACCES 등)를 싣는다 */
export function unreadableFileError(file: string, cause: unknown): Error {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code ?? 'EIO'
  return Object.assign(new Error(tr('error.fileUnreadable', { name: path.basename(file), code })), { code })
}

/** 없으면 undefined. 깨졌으면 옆으로 옮기고 undefined. 그 밖의 읽기 실패는 던진다 (원래 오류 — code 가 실린다) */
export function readJsonFileSync(file: string, shape: JsonShape, now: () => Date = () => new Date()): unknown {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
  const parsed = parse(text, shape)
  if ('value' in parsed) return parsed.value
  const backup = backupName(file, now())
  try {
    fs.renameSync(file, backup)
    report(file, backup, parsed.reason)
  } catch {
    report(file, undefined, parsed.reason)
  }
  return undefined
}

/** readJsonFileSync 의 비동기 판 */
export async function readJsonFile(file: string, shape: JsonShape, now: () => Date = () => new Date()): Promise<unknown> {
  let text: string
  try {
    text = await fs.promises.readFile(file, 'utf8')
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
  const parsed = parse(text, shape)
  if ('value' in parsed) return parsed.value
  const backup = backupName(file, now())
  try {
    await fs.promises.rename(file, backup)
    report(file, backup, parsed.reason)
  } catch {
    report(file, undefined, parsed.reason)
  }
  return undefined
}

export interface WriteJsonOptions {
  /** 사람이 열어 고치는 파일 — 들여 쓰고 줄바꿈으로 끝낸다 */
  pretty?: boolean
  /** 파일 권한 — 비밀(봉한 키·토큰 등)이 들어갈 수 있는 파일은 0o600. 없으면 보통 파일 권한. 임시 파일에 걸고 rename 하므로 이미 있던 파일도 이 권한이 된다 */
  mode?: number
}

/** 임시 파일에 쓰고 rename — 쓰다 죽어도 이전 파일이 남는다 */
export function writeJsonFileSync(file: string, value: unknown, { pretty = false, mode }: WriteJsonOptions = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value), { mode })
  fs.renameSync(temp, file)
}

/** writeJsonFileSync 의 비동기 판 */
export async function writeJsonFile(file: string, value: unknown, { pretty = false, mode }: WriteJsonOptions = {}): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await fs.promises.writeFile(temp, pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value), { mode })
  await fs.promises.rename(temp, file)
}
