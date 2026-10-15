import { Context, Service } from 'cordis'
import fs from 'node:fs'
import path from 'node:path'
import { projectFile } from './fileMentions.ts'

// 라이트코드 디자인의 라이브 미리보기 (이슈 #422) — 우측 패널이 파일을 보고 있는 동안 그 파일이 디스크에서 바뀌면(채팅으로 AI 가
// 수정·터미널·바깥 에디터) 화면이 알아서 다시 읽는다. 화면은 손님 — 파일 판정·모니터링은 메인. 화면은 (directory, token) 으로
// "이것 보고 있다" 를 알린다(미리보기 판정과 같은 projectFile) — 메인은 바뀌면 'design/changed'(absolute) 로 흘리고, 화면은
// 지금 쥔 preview.absolute 와 맞물려 revision 을 올려 다시 읽는다.
//
// - 디렉터리 watch 로 한다(파일 watch 아님) — 저장 도구가 파일을 교체(rename over)하는 경우에도 죽지 않는다. 콜백에서
//   filename 으로 거르고, 파일 이름을 안 주는 플랫폼(Windows)은 그대로 알린다 — 다시 읽기는 저렴하고 화면은 absolute 로만 움직인다
// - 디볼운스는 파일마다 — 한 저장의 여러 이벤트(write + rename)가 알림 하나로 묶인다
// - 참조 카운트는 (directory, token) 키로 — 서로 다른 표기가 같은 realpath 로 풀리면 워처 하나를 쓰고, 다 멈추면 닫는다

declare module 'cordis' {
  interface Context {
    design: DesignService
  }
  interface Events {
    /** 보고 있는 미리보기 파일이 바뀌었다 (바뀜 파일의 absolute) */
    'design/changed'(absolute: string): void
  }
}

/** 기본 디볼운스 — 저장·편집이 연속 사건을 남긴다 */
const DEBOUNCE_MS = 400

export interface DesignWatcherDeps {
  /** (프로젝트 폴더, 칩의 글자) → 프로젝트 안의 파일(realpath). 밖·없으면 undefined (previewFile 과 같은 판정) */
  resolve(directory: string, token: string): Promise<string | undefined>
  /** 디렉터리 watch — filename 이 바뀌면(또는 이름 정보가 없으면) onChange(absolute). 멈출 함수를 준다 */
  watch(dirname: string, filename: string, onChange: (absolute: string) => void): () => void
  /** 보고 있는 파일이 바뀌었다 */
  onChange(absolute: string): void
  debouncedMs?: number
}

export class DesignWatcher {
  private readonly deps: Required<DesignWatcherDeps>
  /** (directory, token) 키 → absolute */
  private readonly byKey = new Map<string, string>()
  /** absolute → 디렉터리 워처·보는 키·디볼운스 타이머 */
  private readonly byFile = new Map<string, { stop: () => void; keys: Set<string>; timer?: ReturnType<typeof setTimeout> }>()

  constructor(deps: DesignWatcherDeps) {
    this.deps = { debouncedMs: DEBOUNCE_MS, ...deps }
  }

  /** (directory, token) 을 보기 시작. 프로젝트 밖이면 false (사유도 안 알려 준다 — previewFile 과 같다) */
  async start(directory: string, token: string): Promise<boolean> {
    if (typeof directory !== 'string' || typeof token !== 'string') return false
    const absolute = await this.deps.resolve(directory, token)
    if (!absolute) return false
    const key = `${directory}\0${token}`
    const existing = this.byFile.get(absolute)
    if (existing) {
      existing.keys.add(key)
    } else {
      const entry: { stop: () => void; keys: Set<string>; timer?: ReturnType<typeof setTimeout> } = {
        stop: this.deps.watch(path.dirname(absolute), path.basename(absolute), () => this.notify(absolute)),
        keys: new Set([key]),
      }
      this.byFile.set(absolute, entry)
    }
    this.byKey.set(key, absolute)
    return true
  }

  /** (directory, token) 을 보지 않는다 (탭을 닫거나 기능이 꺼졌다). 안 보고 있으면 아무 일도 없다 */
  stop(directory: string, token: string): void {
    const key = `${directory}\0${token}`
    const absolute = this.byKey.get(key)
    if (!absolute) return
    this.byKey.delete(key)
    const file = this.byFile.get(absolute)
    if (!file) return
    file.keys.delete(key)
    if (file.keys.size > 0) return
    if (file.timer !== undefined) clearTimeout(file.timer)
    file.stop()
    this.byFile.delete(absolute)
  }

  /** 전부 (기능 묶음이 내려갈 때 — effect 정리) */
  stopAll(): void {
    for (const [absolute, file] of this.byFile) {
      if (file.timer !== undefined) clearTimeout(file.timer)
      file.stop()
      this.byFile.delete(absolute)
    }
    this.byKey.clear()
  }

  /** 디볼운스 — 여러 사건이 하나가 되도록 */
  private notify(absolute: string): void {
    const file = this.byFile.get(absolute)
    if (!file) return
    if (file.timer !== undefined) clearTimeout(file.timer)
    file.timer = setTimeout(() => {
      file.timer = undefined
      this.deps.onChange(absolute)
    }, this.deps.debouncedMs)
  }
}

export class DesignService extends Service {
  private readonly watcher: DesignWatcher

  constructor(ctx: Context) {
    super(ctx, 'design')
    this.watcher = new DesignWatcher({
      resolve: (directory, token) => projectFile(directory, token),
      watch: (dirname, filename, onChange) => {
        const watch = fs.watch(dirname, { persistent: false }, (_event, name) => {
          if (name === null || name === filename) onChange(path.join(dirname, filename))
        })
        return () => {
          watch.close()
        }
      },
      onChange: (absolute) => this.ctx.emit('design/changed', absolute),
    })
    ctx.effect(() => () => this.watcher.stopAll())
  }

  /** 화면 (directory, token) — 보고 있는 미리보기 파일을 보기 시작 */
  async watch(directory: string, token: string): Promise<boolean> {
    return this.watcher.start(directory, token)
  }

  /** 화면 (directory, token) — 보기를 멈춘다 */
  unwatch(directory: string, token: string): void {
    this.watcher.stop(directory, token)
  }
}
