import fs from 'node:fs'
import path from 'node:path'
import { format } from 'node:util'

// 메인 프로세스 로그 파일 (참고 레포 검토 02x A·D·E) — 설치본에는 터미널이 없어 console.error/warn 이 어디에도 안 남았다.
// userData/logs/main.log 에 줄 단위로 덧붙이고, 크기 상한을 넘으면 main.1.log → main.2.log 로 밀어 낸다(파일 수 상한, 새 의존성 없음).
// - 동기로 쓴다: 치명 오류 직후 프로세스가 죽어도 줄이 남아야 한다 (양이 적다 — 오류·경고만)
// - 쓰기 실패는 삼킨다: 로그 때문에 앱이 죽으면 안 된다
// - **비밀을 쓰지 않는다**: 줄마다 redactSecrets 를 거친다(Authorization·Bearer/Basic 값·키 모양·주소 안 비밀번호). 그물일 뿐이다 —
//   오류 문구에 키를 싣지 않는 것은 여전히 각 서비스의 책임이다 (keyProxy·providers·mcpClient 의 주석)

export const LOG_MAX_BYTES = 1024 * 1024
export const LOG_FILES = 3

export type LogLevel = 'error' | 'warn'

export interface LogFile {
  /** 지금 쓰는 파일 */
  path: string
  write(level: LogLevel, args: readonly unknown[]): void
}

/** 로그에 실리면 안 되는 값을 가린다 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/(authorization|x-api-key|api[-_]?key|password|passwd|secret|token)(["']?\s*[:=]\s*["']?)(?!Bearer\b|Basic\b|\[redacted\])[^\s"',;&}]{4,}/gi, '$1$2[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]')
    .replace(/(\/\/[^/\s:@]+):[^/\s@]+@/g, '$1:[redacted]@')
}

export function createLogFile(dir: string, opts: { maxBytes?: number; files?: number; now?: () => Date } = {}): LogFile {
  const maxBytes = opts.maxBytes ?? LOG_MAX_BYTES
  const files = opts.files ?? LOG_FILES
  const now = opts.now ?? (() => new Date())
  const file = path.join(dir, 'main.log')
  const numbered = (index: number): string => (index === 0 ? file : path.join(dir, `main.${index}.log`))
  let size: number | undefined // 처음 쓸 때 잰다

  const rotate = (): void => {
    fs.rmSync(numbered(files - 1), { force: true })
    for (let index = files - 2; index >= 0; index--) {
      if (fs.existsSync(numbered(index))) fs.renameSync(numbered(index), numbered(index + 1))
    }
    size = 0
  }

  return {
    path: file,
    write(level, args) {
      try {
        const line = `${now().toISOString()} ${level.toUpperCase()} ${redactSecrets(format(...args))}\n`
        const bytes = Buffer.byteLength(line)
        if (size === undefined) {
          fs.mkdirSync(dir, { recursive: true })
          size = fs.existsSync(file) ? fs.statSync(file).size : 0
        }
        if (size > 0 && size + bytes > maxBytes) rotate()
        fs.appendFileSync(file, line, { mode: 0o600 })
        size += bytes
      } catch {
        // 못 써도 앱은 돈다
      }
    },
  }
}

/** console.error·console.warn 이 로그 파일에도 남게 한다 (원래 출력은 그대로). 되돌리는 함수를 준다 */
export function captureConsole(log: LogFile, target: Pick<Console, LogLevel> = console): () => void {
  const original = { error: target.error, warn: target.warn }
  for (const level of ['error', 'warn'] as const) {
    target[level] = (...args: unknown[]) => {
      original[level].apply(target, args)
      log.write(level, args)
    }
  }
  return () => {
    target.error = original.error
    target.warn = original.warn
  }
}
