import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

// 그 폴더로 엔진을 부르면 opencode 가 import 할 파일을 **엔진 없이** 찾는다 (이슈 #101, 실측 2026-10-05 opencode 1.18.18 —
// _workspace/01ah_plugin_block.md, 재현 _workspace/probe-01ah/).
//
// 왜: opencode 의 신규 세대 런타임(내장 플러그인 `config-plugin`)은 그 폴더의 **첫 `/api/*` 호출과 첫 레거시 턴**에 아래 파일을 엔진 프로세스 안에서
// `import()` 한다 — 계획 모드·승인과 무관하고 화면에 아무것도 안 남는다. 끄는 스위치가 없다(`--pure`·`OPENCODE_DISABLE_PROJECT_CONFIG`·
// `plugin: []` 등 22개 경우 66/66 그대로 import). 그래서 ctx.llm 이 폴더를 엔진에 넘기기 전에 여기서 보고, 하나라도 있으면 넘기지 않는다.
//
// 엔진이 import 하는 것 (세션 폴더 = realpath 기준):
// - 세션 폴더에서 프로젝트 최상위까지 올라가며 폴더마다 `.opencode/{plugin,plugins}/` **바로 아래**의 `*.ts`·`*.js` **파일** — 숨김 파일 포함,
//   심볼릭 링크는 따라간다, macOS 는 대소문자를 안 가린다(`PLUGIN/U.JS`·`.OpenCode/` 3/3). 하위 폴더·`.mjs`·`.cjs`·`.tsx`·`.mts`·이름이 `x.js` 인
//   폴더·`.opencode/tool/`·프로젝트 루트 `plugin/` 은 아니다(0/3)
// - 그 폴더들의 `opencode.json`·`opencode.jsonc` 의 `plugin`(v1)·`plugins`(v2) 항목 — 문자열·`[경로, 옵션]`·`{package}`. 상대·절대·`file://`
//   아무 경로(저장소 밖도)나 그 파일을, 그 밖은 npm 이름으로 보고 레지스트리에 요청한다(3/3)
// - 앱 CONFIG_DIR 의 `plugin/`·`plugins/` (어느 폴더에서든 9/9). 개인 설정 `~/.config/opencode/plugin` 은 안 돈다(0/9 — CONFIG_DIR 이 대신한다)
//
// 엔진보다 넓게 잡는 곳 (안전한 쪽 — 리더 결정 2026-10-05):
// - **`/` 까지 올라간다.** 엔진은 git 저장소면 git 최상위에서 멈추지만, git 이 아니라고 보는 폴더(빈 `.git/` 만 있는 곳 포함)는 `/` 까지 간다 —
//   `.git` 유무로 멈추면 그 차이만큼 샌다. 대가: git 저장소 위 폴더(예: `~/.opencode/plugin`)에 플러그인이 있으면 엔진은 안 읽는데도 거절한다
// - 설정 파일이 엄격한 JSON 이 아니면(주석·끝 쉼표·깨짐) 글자에 `plugin` 이나 `\u` 가 있는 것만으로 걸린 것으로 본다. 주석을 걷어 내고 다시
//   읽지 않는다 — 문자열 안의 `/* … */` 로 `plugin` 키를 가릴 수 있다: `{"x":"/*","plugin":["./e.js"],"y":"*/",\n// c\n"z":1}`
// - 대소문자는 어느 OS 에서든 무시한다
//
// opencode 버전을 올리면 probe-01ah 의 e1·e5·e7 을 다시 돌려 이 규칙을 대조한다.

export interface EnginePluginHit {
  /** 걸린 파일 — 플러그인 파일 자신, 또는 플러그인 항목을 가진 설정 파일 */
  path: string
  /** file: 플러그인 폴더의 파일 · config-entry: 설정의 plugin(s) 항목 · config-unparsed: 엄격히 못 읽은 설정에 plugin 글자가 있다 */
  kind: 'file' | 'config-entry' | 'config-unparsed'
  /** 세션 폴더 자신의 것 · 그 위 폴더의 것 · 앱 CONFIG_DIR 의 것 */
  where: 'project' | 'above' | 'app'
  /** config-entry: 항목 값 (경로나 npm 이름) */
  entry?: string
}

/** 검사가 쓰는 파일 시스템 — 시험이 바꿔 끼운다 */
export interface EnginePluginIo {
  readdir(dir: string): Promise<string[]>
  readFile(file: string): Promise<string>
  /** 심볼릭 링크를 따라가서 파일인가 */
  isFile(file: string): Promise<boolean>
}

const nodeIo: EnginePluginIo = {
  readdir: (dir) => fsp.readdir(dir),
  readFile: (file) => fsp.readFile(file, 'utf8'),
  isFile: (file) => fsp.stat(file).then((stat) => stat.isFile(), () => false),
}

const PLUGIN_DIRS = new Set(['plugin', 'plugins'])
const CONFIG_FILES = new Set(['opencode.json', 'opencode.jsonc'])
const PLUGIN_FILE = /\.(ts|js)$/i
const PLUGIN_KEYS = ['plugin', 'plugins'] as const

/** 그 폴더(realpath)로 엔진을 부르면 opencode 가 import 할 것. 빈 배열이면 넘겨도 된다. configDir 는 앱 CONFIG_DIR.
 *  읽지 못하는 폴더·파일은 없는 것으로 본다(엔진도 못 읽는다). **결과를 캐시하지 말 것** — 턴 중에 AI 가 만든 파일은 엔진을 다시 띄운 뒤 첫 호출에
 *  실행된다(01ah 2-2) */
export async function findEnginePlugins(workdir: string, configDir: string | undefined, io: EnginePluginIo = nodeIo): Promise<EnginePluginHit[]> {
  const hits: EnginePluginHit[] = []
  for (let dir = workdir, where: EnginePluginHit['where'] = 'project'; ; where = 'above') {
    const names = await list(io, dir)
    for (const name of names) if (name.toLowerCase() === '.opencode') hits.push(...(await pluginFiles(io, path.join(dir, name), where)))
    hits.push(...(await configEntries(io, dir, names, where)))
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (configDir) {
    hits.push(...(await pluginFiles(io, configDir, 'app')))
    hits.push(...(await configEntries(io, configDir, await list(io, configDir), 'app')))
  }
  const seen = new Set<string>()
  return hits.filter((hit) => {
    const key = `${hit.kind}\n${hit.path}\n${hit.entry ?? ''}`
    return !seen.has(key) && seen.add(key)
  })
}

async function list(io: EnginePluginIo, dir: string): Promise<string[]> {
  return (await io.readdir(dir).catch(() => [] as string[])).sort()
}

/** `<base>/{plugin,plugins}/*.{ts,js}` — 바로 아래의 파일만 */
async function pluginFiles(io: EnginePluginIo, base: string, where: EnginePluginHit['where']): Promise<EnginePluginHit[]> {
  const hits: EnginePluginHit[] = []
  for (const sub of await list(io, base)) {
    if (!PLUGIN_DIRS.has(sub.toLowerCase())) continue
    for (const name of await list(io, path.join(base, sub))) {
      const file = path.join(base, sub, name)
      if (PLUGIN_FILE.test(name) && (await io.isFile(file))) hits.push({ path: file, kind: 'file', where })
    }
  }
  return hits
}

/** 그 폴더의 `opencode.json`·`opencode.jsonc` 가 가진 플러그인 항목 */
async function configEntries(io: EnginePluginIo, dir: string, names: readonly string[], where: EnginePluginHit['where']): Promise<EnginePluginHit[]> {
  const hits: EnginePluginHit[] = []
  for (const name of names) {
    if (!CONFIG_FILES.has(name.toLowerCase())) continue
    const file = path.join(dir, name)
    const text = await io.readFile(file).catch(() => undefined)
    if (text === undefined) continue
    const entries = pluginEntries(text)
    if (entries === 'unparsed') hits.push({ path: file, kind: 'config-unparsed', where })
    else for (const entry of entries) hits.push({ path: file, kind: 'config-entry', where, entry })
  }
  return hits
}

/** 설정 글의 플러그인 항목 값들. 엄격히 읽을 수 없는데 플러그인 항목이 있을 수 있으면 'unparsed' */
function pluginEntries(text: string): string[] | 'unparsed' {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return /plugin|\\u/.test(text) ? 'unparsed' : []
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return []
  const entries: string[] = []
  let empty = 0
  for (const key of PLUGIN_KEYS) {
    if (!Object.hasOwn(doc, key)) continue
    const value = (doc as Record<string, unknown>)[key]
    const list = value === null || value === undefined ? [] : Array.isArray(value) ? value : [value] // 배열이 아닌 값도 넓게 잡는다
    if (list.length === 0) empty++
    for (const item of list) entries.push(entryText(item))
  }
  // 같은 키를 두 번 적으면 JSON.parse 는 뒤의 것만 준다 — 엔진의 읽기가 같은지는 재지 않았다. 빈 값의 키가 있는데 글자에 `plugin` 이 그 키들보다
  // 더 나오거나 `\u`(이스케이프로 적은 같은 키)가 있으면 가려진 항목이 있을 수 있다
  if (entries.length === 0 && empty > 0 && ((text.match(/plugin/g) ?? []).length > empty || text.includes('\\u'))) return 'unparsed'
  return entries
}

/** 항목 하나의 값 — 문자열, `[경로, 옵션]`, `{package}` (01ah 2-1). 그 밖의 모양은 글자 그대로 */
function entryText(item: unknown): string {
  const spec = Array.isArray(item) ? item[0] : typeof item === 'object' && item !== null ? (item as { package?: unknown }).package : item
  return typeof spec === 'string' ? spec : JSON.stringify(item)
}

const SHOWN = 5

/** 거절 사유에 실을 목록 — 경로(설정 항목은 값까지), 많으면 앞의 다섯 개와 나머지 수 */
export function describeEnginePlugins(hits: readonly EnginePluginHit[]): string {
  const shown = hits.slice(0, SHOWN).map((hit) => (hit.entry === undefined ? hit.path : `${hit.path} (${JSON.stringify(hit.entry)})`))
  return shown.join(', ') + (hits.length > SHOWN ? ` (+${hits.length - SHOWN})` : '')
}

/** 앱 CONFIG_DIR 의 `plugin/`·`plugins/` 를 지운다 — 엔진 기동 직전에 (ctx.engine). 앱이 만든 폴더고 앱은 엔진 플러그인을 쓰지 않는다:
 *  여기 놓인 파일은 **모든 프로젝트**에서 엔진 안에 실린다(01ah 2-1, 9/9). 실행 중에 생긴 것은 findEnginePlugins 가 다음 호출에서 잡는다 */
export function removeAppPluginDirs(configDir: string): void {
  let names: string[]
  try {
    names = fs.readdirSync(configDir)
  } catch {
    return
  }
  for (const name of names) if (PLUGIN_DIRS.has(name.toLowerCase())) fs.rmSync(path.join(configDir, name), { recursive: true, force: true })
}
