// 로그인 셸의 PATH — Finder·Dock 으로 띄운 앱의 PATH 는 /usr/bin:/bin:/usr/sbin:/sbin 뿐이라 opencode 자식(bash 도구·로컬 MCP 서버의
// npx·node)이 사용자의 도구를 못 찾는다 (이슈 #84). `!명령` 은 명령마다 로그인 셸로 띄우지만(shell.ts) 엔진은 한 번 떠서 오래 돌므로
// 띄우기 전에 PATH 만 한 번 읽어 합친다. Windows 는 해당 없다(GUI 앱도 사용자 PATH 를 받는다).
import { execFile } from 'node:child_process'
import path from 'node:path'

const MARK = '__LITECODE_PATH__'
const TIMEOUT_MS = 5_000

/** 셸 출력에서 PATH 를 꺼낸다 — 로그인 스크립트가 찍는 글(환영 문구 등)은 표식 밖이라 버려진다 */
export function parseLoginPath(stdout: string): string | undefined {
  const found = stdout.split(MARK)[1]?.trim()
  return found || undefined
}

/** 로그인 셸 것을 앞에, 원래 것을 뒤에 — 겹치는 것은 한 번만 */
export function mergePath(login: string | undefined, current: string | undefined, delimiter = path.delimiter): string {
  const entries = [...(login ?? '').split(delimiter), ...(current ?? '').split(delimiter)].filter(Boolean)
  return [...new Set(entries)].join(delimiter)
}

// `"${PATH}"` 로 찍지 않는다 — fish 는 `${…}` 가 문법 오류다 (이슈 #126). printenv 는 sh·zsh·bash·fish 어디서나 같은 env 값을 찍는다
// (끝의 줄바꿈은 parseLoginPath 가 뗀다). 진짜 fish 로 돌려 보지는 않았다
const COMMAND = `printf %s ${MARK}; printenv PATH; printf %s ${MARK}`

/** 로그인 셸의 PATH. 못 읽으면(시간 초과·셸 없음·Windows) undefined — 부르는 쪽은 원래 PATH 로 간다 */
export function readLoginPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<string | undefined> {
  if (platform === 'win32') return Promise.resolve(undefined)
  return new Promise((resolve) => {
    execFile(env['SHELL'] || '/bin/sh', ['-lc', COMMAND], { env, timeout: TIMEOUT_MS }, (error, stdout) => {
      if (error) console.warn('[engine] 로그인 셸의 PATH 를 못 읽었다', error.message)
      resolve(error ? undefined : parseLoginPath(String(stdout)))
    })
  })
}
