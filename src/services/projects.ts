import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { tr } from '../i18n.ts'
import { readJsonFile, unreadableFileError, writeJsonFile } from './jsonFile.ts'
import type { Project } from '../../shared/contract.ts'

// 화면에 실리는 타입의 정의는 shared/contract.ts 에 있다 (모바일 앱과 같이 쓴다 — 이슈 #42). 여기서는 다시 내보내기만 한다
export type { Project } from '../../shared/contract.ts'

// 최근 프로젝트 목록 — 프로젝트 = 폴더. 재시작해도 남도록 작은 JSON 파일 하나에 둔다 (앱에서는 userData 아래).
// 목록 맨 앞이 마지막으로 연 프로젝트다 — 앱을 켜면 그것을 연다.
// 즐겨찾기는 같은 목록 안의 표시(favorites)다 — 순서는 최근 순 그대로, 화면이 즐겨찾기/최근 두 묶음으로 나눈다.
// 목록에서 빼기(remove)·이름 바꾸기(rename)는 파일 속 목록만 고친다. 사용자 폴더는 절대 건드리지 않는다
// (이름은 화면에 보이는 별명일 뿐 — 디스크의 폴더 이름은 그대로).
//
// 식별자는 fs.realpath 한 절대 경로 하나로 통일한다. opencode 는 세션 디렉터리를 realpath·끝 슬래시 정규화 없이
// 문자열 그대로 저장·비교한다 (2026-09-30 실측, _workspace/01_probe.md Q3) — 목록 키와 ctx.llm 에 넘기는 값이
// 달라지면 같은 폴더가 둘로 갈린다.

declare module 'cordis' {
  interface Context {
    projects: ProjectsService
  }
  interface Events {
    /** 최근 목록에서 뺐다 (폴더는 그대로) — ctx.notifications 가 그 프로젝트의 알림을 거둔다 */
    'projects/removed'(dir: string): void
  }
}

interface Stored {
  /** 최근에 연 순서 (맨 앞이 마지막) — 즐겨찾기 포함 모든 프로젝트 */
  recent: string[]
  favorites: string[]
  /** path → 사용자가 붙인 이름 */
  names: Record<string, string>
}

export interface ProjectsServiceOptions {
  /** 최근 목록 JSON 파일 경로 */
  file: string
}

export class ProjectsService extends Service {
  constructor(
    ctx: Context,
    private opts: ProjectsServiceOptions,
  ) {
    super(ctx, 'projects')
  }

  /** 읽기-고치기-쓰기를 한 줄로 세운다 — 겹치면 한쪽 갱신이 사라진다 (03_qa) */
  private queue: Promise<unknown> = Promise.resolve()

  /** 최근에 연 순서 (맨 앞이 마지막으로 연 프로젝트) */
  async list(): Promise<Project[]> {
    return toProjects(await this.readOrEmpty())
  }

  /** 등록된 프로젝트인가 — 목록의 path 와 글자 그대로 같을 때만(정규화하지 않는다). 화면이 오염돼도 아무 폴더나 읽거나 만들지 못하게 막는 문이다 */
  async has(dir: string): Promise<boolean> {
    return (await this.list()).some((project) => project.path === dir)
  }

  /** 폴더를 열어 최근 목록 맨 앞에 올린다. 폴더가 아니면(없는 경로·파일) 목록을 안 바꾸고 throw 한다. */
  async open(dir: string): Promise<Project> {
    const real = await fs.realpath(dir)
    if (!(await fs.stat(real)).isDirectory()) throw new Error(tr('error.notFolder', { dir }))

    const stored = await this.update((current) => ({ ...current, recent: [real, ...current.recent.filter((entry) => entry !== real)] }))
    return toProjects(stored).find((project) => project.path === real)!
  }

  /** dir 은 목록의 path 그대로 (지워진 폴더일 수 있어 realpath 하지 않는다) */
  async setFavorite(dir: string, favorite: boolean): Promise<Project[]> {
    return toProjects(
      await this.update(({ recent, favorites, names }) => ({
        recent,
        names,
        favorites: favorite ? [...favorites.filter((entry) => entry !== dir), dir] : favorites.filter((entry) => entry !== dir),
      })),
    )
  }

  /** 목록·즐겨찾기에서만 뺀다 — 폴더는 디스크에 그대로. dir 은 목록의 path 그대로 */
  async remove(dir: string): Promise<Project[]> {
    const stored = await this.update(({ recent, favorites, names }) => ({
      recent: recent.filter((entry) => entry !== dir),
      favorites: favorites.filter((entry) => entry !== dir),
      names: without(names, dir),
    }))
    this.ctx.emit('projects/removed', dir)
    return toProjects(stored)
  }

  /** 보이는 이름만 바꾼다(폴더는 그대로). 빈 이름이면 폴더 이름으로 되돌린다. dir 은 목록의 path 그대로 */
  async rename(dir: string, name: string): Promise<Project[]> {
    const trimmed = name.trim()
    return toProjects(
      await this.update((current) => ({ ...current, names: trimmed ? { ...current.names, [dir]: trimmed } : without(current.names, dir) })),
    )
  }

  private update(mutate: (stored: Stored) => Stored): Promise<Stored> {
    const next = this.queue.then(async () => {
      const stored = mutate(await this.read())
      await writeJsonFile(this.opts.file, stored) // 쓰다 죽어도 이전 파일이 남게
      return stored
    })
    this.queue = next.catch(() => {}) // 한 번 실패해도 다음 갱신은 돈다
    return next
  }

  /** 파일이 없거나 손상됐으면 빈 목록 — 최근 목록은 잃어도 되는 편의 데이터라 앱 시작을 막지 않는다. 손상된 파일은 옆에 옮겨 둔다 (jsonFile.ts).
   *  읽기 자체가 실패하면(권한 등) 던진다 — 빈 목록 위에 고쳐 쓰면 원본이 사라진다 (이슈 #195). 그래서 update 는 쓰지 않고 실패한다 */
  private async read(): Promise<Stored> {
    let parsed: Partial<Record<keyof Stored, unknown>> | undefined
    try {
      parsed = (await readJsonFile(this.opts.file, 'object')) as Partial<Record<keyof Stored, unknown>> | undefined
    } catch (error) {
      throw unreadableFileError(this.opts.file, error)
    }
    const recent = strings(parsed?.recent)
    const names = Object.fromEntries(
      Object.entries(typeof parsed?.names === 'object' && parsed.names ? parsed.names : {}).filter(
        (entry): entry is [string, string] => recent.includes(entry[0]) && typeof entry[1] === 'string',
      ),
    )
    return { recent, favorites: strings(parsed?.favorites).filter((entry) => recent.includes(entry)), names }
  }

  /** 보여 주기만 하는 읽기 — 못 읽는 파일이면 빈 목록으로 (앱 시작을 막지 않는다). 쓰는 길은 read 로 던진다 */
  private readOrEmpty(): Promise<Stored> {
    return this.read().catch((error: unknown) => {
      console.warn(`[projects] ${(error as Error).message}`)
      return { recent: [], favorites: [], names: {} }
    })
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : []
}

function without(names: Record<string, string>, dir: string): Record<string, string> {
  return Object.fromEntries(Object.entries(names).filter(([entry]) => entry !== dir))
}

function toProjects({ recent, favorites, names }: Stored): Project[] {
  const home = os.homedir()
  return recent.map((dir) => ({
    path: dir,
    name: names[dir] ?? path.basename(dir),
    displayPath: dir === home || dir.startsWith(`${home}${path.sep}`) ? `~${dir.slice(home.length)}` : dir,
    favorite: favorites.includes(dir),
  }))
}
