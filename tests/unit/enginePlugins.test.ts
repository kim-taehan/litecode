import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { describeEnginePlugins, findEnginePlugins, removeAppPluginDirs, type EnginePluginHit, type EnginePluginIo } from '../../src/services/enginePlugins.ts'

// 엔진이 그 폴더에서 import 할 파일을 엔진 없이 예측한다 (이슈 #101, 실측 _workspace/01ah_plugin_block.md).
// 규칙의 기준은 probe-01ah/check.py — 실제 import 와 27/27(세션 폴더 9개 × 3) 일치한 것의 "넓은" 판(`/` 까지)이다.

/** 이 파일이 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'litecode-engineplugins-')))
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

/** ROOT 밖은 없는 것으로 보이는 파일 시스템 — 이 기계의 상위 폴더(`/tmp/.opencode` 등)에 뭐가 있든 결과가 같게 */
const jailed: EnginePluginIo = {
  readdir: (dir) => (inside(dir) ? fsp.readdir(dir) : Promise.reject(new Error('ENOENT'))),
  readFile: (file) => fsp.readFile(file, 'utf8'),
  isFile: (file) => fsp.stat(file).then((stat) => stat.isFile(), () => false),
}
function inside(target: string): boolean {
  return target === ROOT || target.startsWith(ROOT + path.sep)
}

let cases = 0
/** 새 빈 폴더(ROOT 아래)에 파일을 심는다. 값이 null 이면 폴더 */
function plant(files: Record<string, string | null>): string {
  const base = path.join(ROOT, `case-${++cases}`)
  fs.mkdirSync(path.join(base, 'proj'), { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(base, rel)
    if (content === null) fs.mkdirSync(target, { recursive: true })
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
    }
  }
  return base
}
/** 세션 폴더는 늘 `<base>/proj`, 앱 설정 폴더는 `<base>/config` */
async function hitsOf(files: Record<string, string | null>): Promise<{ base: string; hits: EnginePluginHit[] }> {
  const base = plant(files)
  return { base, hits: await findEnginePlugins(path.join(base, 'proj'), path.join(base, 'config'), jailed) }
}

describe('findEnginePlugins — 걸린다', () => {
  const caught: [string, Record<string, string | null>, string][] = [
    ['.opencode/plugin/a.js', { 'proj/.opencode/plugin/a.js': '' }, 'proj/.opencode/plugin/a.js'],
    ['.opencode/plugins/b.ts', { 'proj/.opencode/plugins/b.ts': '' }, 'proj/.opencode/plugins/b.ts'],
    ['숨김 파일', { 'proj/.opencode/plugin/.hidden.js': '' }, 'proj/.opencode/plugin/.hidden.js'],
    ['대문자 폴더·확장자', { 'proj/.opencode/PLUGIN/U.JS': '' }, 'proj/.opencode/PLUGIN/U.JS'],
    ['대문자 .OpenCode', { 'proj/.OpenCode/plugin/a.js': '' }, 'proj/.OpenCode/plugin/a.js'],
    ['위 폴더의 것', { '.opencode/plugin/up.js': '', 'proj': null }, '.opencode/plugin/up.js'],
    ['opencode.json 의 plugin (문자열)', { 'proj/opencode.json': '{"plugin":["./p.js"]}' }, 'proj/opencode.json'],
    ['opencode.json 의 plugin ([경로, 옵션])', { 'proj/opencode.json': '{"plugin":[["./p.js",{}]]}' }, 'proj/opencode.json'],
    ['opencode.json 의 plugins ({package})', { 'proj/opencode.json': '{"plugins":[{"package":"/abs/p.js"}]}' }, 'proj/opencode.json'],
    ['npm 이름', { 'proj/opencode.json': '{"plugin":["some-plugin@1.0.0"]}' }, 'proj/opencode.json'],
    ['저장소 밖을 가리키는 항목', { 'proj/opencode.json': '{"plugin":["../../out.js","file:///tmp/x.js"]}' }, 'proj/opencode.json'],
    ['상위 폴더의 opencode.json', { 'opencode.json': '{"plugins":["./p.js"]}' }, 'opencode.json'],
    ['주석 있는 opencode.jsonc 에 plugin 글자', { 'proj/opencode.jsonc': '{ /* c */ "plugin": ["./c1.js",], }\n' }, 'proj/opencode.jsonc'],
    ['대문자 OpenCode.JSON', { 'proj/OpenCode.JSON': '{"plugin":["./p.js"]}' }, 'proj/OpenCode.JSON'],
    ['앱 설정 폴더 plugin/x.js', { 'config/plugin/x.js': '' }, 'config/plugin/x.js'],
    ['앱 설정 폴더 plugins/x.ts', { 'config/plugins/x.ts': '' }, 'config/plugins/x.ts'],
    ['앱 설정 폴더 opencode.jsonc 의 plugin', { 'config/opencode.jsonc': '{"plugin":["./p.js"]}' }, 'config/opencode.jsonc'],
  ]
  it.each(caught)('%s', async (_name, files, expected) => {
    const { base, hits } = await hitsOf(files)
    expect(hits.map((hit) => path.relative(base, hit.path))).toContain(expected)
  })

  it('저장소 밖 파일을 가리키는 심볼릭 링크', async () => {
    const base = plant({ 'outside.js': '', 'proj/.opencode/plugins': null })
    fs.symlinkSync(path.join(base, 'outside.js'), path.join(base, 'proj/.opencode/plugins/s.js'))
    const hits = await findEnginePlugins(path.join(base, 'proj'), undefined, jailed)
    expect(hits).toEqual([{ path: path.join(base, 'proj/.opencode/plugins/s.js'), kind: 'file', where: 'project' }])
  })

  it('.git 이 중간에 있어도 그 위의 것까지 본다 (엔진이 git 이 아니라고 보는 폴더는 / 까지 올라간다)', async () => {
    const { base, hits } = await hitsOf({ '.opencode/plugin/up.js': '', 'proj/.git': null })
    expect(hits).toEqual([{ path: path.join(base, '.opencode/plugin/up.js'), kind: 'file', where: 'above' }])
  })

  it('가리기 반례 — 문자열 안의 주석 표시로 plugin 키를 가려도 걸린다 (주석을 걷어 내고 다시 읽지 않는다)', async () => {
    const { hits } = await hitsOf({ 'proj/opencode.jsonc': '{"x":"/*","plugin":["./e.js"],"y":"*/",\n// c\n"z":1}' })
    expect(hits.map((hit) => hit.kind)).toEqual(['config-unparsed'])
  })

  it('엄격히 못 읽는 설정에 \\u 가 있으면 걸린다 (plugin 을 유니코드 이스케이프로 적을 수 있다)', async () => {
    const { hits } = await hitsOf({ 'proj/opencode.jsonc': '{ // c\n"plu\\u0067in": ["./e.js"] }' })
    expect(hits.map((hit) => hit.kind)).toEqual(['config-unparsed'])
  })

  it('같은 키를 두 번 적어 빈 배열로 덮어도 걸린다', async () => {
    expect((await hitsOf({ 'proj/opencode.json': '{"plugin":["./e.js"],"plugin":[]}' })).hits.map((hit) => hit.kind)).toEqual(['config-unparsed'])
    expect((await hitsOf({ 'proj/opencode.json': '{"plu\\u0067in":["./e.js"],"plugin":[]}' })).hits.map((hit) => hit.kind)).toEqual(['config-unparsed'])
  })

  it('항목마다 값과 위치(project·above·app)를 싣는다', async () => {
    const { base, hits } = await hitsOf({
      'proj/opencode.json': '{"plugin":["./p1.js",["../up.js",{}]],"plugins":[{"package":"npm-name"}]}',
      'opencode.json': '{"plugin":["x"]}',
      'config/plugin/l.js': '',
    })
    expect(hits).toEqual([
      { path: path.join(base, 'proj/opencode.json'), kind: 'config-entry', where: 'project', entry: './p1.js' },
      { path: path.join(base, 'proj/opencode.json'), kind: 'config-entry', where: 'project', entry: '../up.js' },
      { path: path.join(base, 'proj/opencode.json'), kind: 'config-entry', where: 'project', entry: 'npm-name' },
      { path: path.join(base, 'opencode.json'), kind: 'config-entry', where: 'above', entry: 'x' },
      { path: path.join(base, 'config/plugin/l.js'), kind: 'file', where: 'app' },
    ])
  })
})

describe('findEnginePlugins — 안 걸린다', () => {
  const clean: [string, Record<string, string | null>][] = [
    ['빈 폴더', {}],
    ['하위 폴더 plugin/deep/x.js', { 'proj/.opencode/plugin/deep/x.js': '' }],
    ['x.mjs · x.cjs · x.tsx · x.mts', { 'proj/.opencode/plugin/x.mjs': '', 'proj/.opencode/plugin/x.cjs': '', 'proj/.opencode/plugin/x.tsx': '', 'proj/.opencode/plugin/x.mts': '' }],
    ['이름이 x.js 인 폴더', { 'proj/.opencode/plugin/x.js/index.js': '' }],
    ['.opencode/tool/x.js · .opencode/x.js', { 'proj/.opencode/tool/x.js': '', 'proj/.opencode/tools/x.js': '', 'proj/.opencode/x.js': '' }],
    ['프로젝트 루트 plugin/x.js', { 'proj/plugin/x.js': '' }],
    ['"plugin": []', { 'proj/opencode.json': '{"plugin":[],"plugins":[]}' }],
    ['plugin 키가 없는 opencode.json', { 'proj/opencode.json': '{"model":"a/b","mcp":{}}' }],
    ['plugin 글자가 없는 jsonc', { 'proj/opencode.jsonc': '{ // c\n"model": "a/b", }' }],
    ['하위 폴더의 것 (엔진은 위로만 올라간다)', { 'proj/sub/.opencode/plugin/x.js': '', 'proj/sub/opencode.json': '{"plugin":["./p.js"]}' }],
    ['옆 폴더의 것', { 'other/.opencode/plugin/x.js': '' }],
    ['앱 설정 폴더의 다른 것 (스킬·생성한 opencode.json)', { 'config/skills/a/SKILL.md': '', 'config/opencode.json': '{"model":"a/b"}', 'config/node_modules': null }],
  ]
  it.each(clean)('%s', async (_name, files) => {
    expect((await hitsOf(files)).hits).toEqual([])
  })

  it('읽을 수 없는 상위 폴더는 없는 것으로 본다 (엔진도 못 읽는다)', async () => {
    const base = plant({})
    const denied: EnginePluginIo = { ...jailed, readdir: (dir) => (dir === base ? Promise.reject(new Error('EACCES')) : jailed.readdir(dir)) }
    expect(await findEnginePlugins(path.join(base, 'proj'), undefined, denied)).toEqual([])
  })

  it('기본 파일 시스템으로도 돈다 (진짜 `/` 까지 — 결과는 이 기계에 달렸으므로 던지지 않는 것만 본다)', async () => {
    await expect(findEnginePlugins(path.join(plant({}), 'proj'), undefined)).resolves.toBeInstanceOf(Array)
  })
})

// probe-01ah/e7_check.py 의 배치 그대로 — 세션 폴더 9개. 엔진의 실제 import(27/27 은 git 최상위에서 멈춘 판)는 아래 목록의 부분집합이다:
// 넓은 판은 git 최상위 위의 것까지 든다(리더 결정: 상위 폴더의 것도 거절)
describe('findEnginePlugins — 실측 배치 (probe-01ah e7)', () => {
  const R = path.join(ROOT, 'e7')
  const p = (rel: string): string => path.join(R, rel)
  const write = (rel: string, content = ''): void => {
    fs.mkdirSync(path.dirname(p(rel)), { recursive: true })
    fs.writeFileSync(p(rel), content)
  }
  const PLANTED = ['outer', 'outer/repo', 'outer/repo/sub', 'outer/repo/inner', 'wtparent', 'wtparent/wt', 'fake', 'fake/proj', 'fake/proj/deep', 'ng', 'ng/proj', 'home', 'home/hp']
  for (const rel of PLANTED) write(`${rel}/.opencode/plugin/m.js`)
  for (const dir of ['fake/proj/.git', 'clean/proj', 'home/gitp', 'outer/repo/.git', 'outer/repo/inner/.git', 'clean/proj/.git', 'home/gitp/.git']) fs.mkdirSync(p(dir), { recursive: true })
  write('.opencode/plugins/n.ts')
  write('outer/repo/.opencode/PLUGINS/Up.JS')
  write('outer/repo/.opencode/plugin/.hid.js')
  write('outer/repo/.opencode/plugin/no.tsx')
  write('outer/repo/.opencode/plugin/deep/m.js')
  write('outer/repo/.opencode/plugin/d.js/index.js')
  for (const target of ['outer/repo/sub/p1.js', 'outer/up.js', 'outer/abs.js', 'ng/c1.js']) write(target)
  write('outer/repo/sub/opencode.json', JSON.stringify({ plugin: ['./p1.js', ['../../up.js', {}]] }))
  write('outer/repo/opencode.json', JSON.stringify({ plugins: [{ package: p('outer/abs.js') }] }))
  write('ng/opencode.jsonc', '{ /* c */ "plugin": ["./c1.js",], }\n')
  write('fake/opencode.json', '{ "plugin": ["./nope.js"] oops')
  fs.symlinkSync(p('outer/up.js'), p('wtparent/wt/.opencode/plugin/link.js'))

  /** 폴더 → 그 폴더 자신이 내는 것 (`경로` 또는 `경로 = 항목`) */
  const OWN: Record<string, string[]> = {
    '': ['.opencode/plugins/n.ts'],
    outer: ['outer/.opencode/plugin/m.js'],
    'outer/repo': ['outer/repo/.opencode/PLUGINS/Up.JS', 'outer/repo/.opencode/plugin/.hid.js', 'outer/repo/.opencode/plugin/m.js', `outer/repo/opencode.json = ${p('outer/abs.js')}`],
    'outer/repo/sub': ['outer/repo/sub/.opencode/plugin/m.js', 'outer/repo/sub/opencode.json = ./p1.js', 'outer/repo/sub/opencode.json = ../../up.js'],
    'outer/repo/inner': ['outer/repo/inner/.opencode/plugin/m.js'],
    wtparent: ['wtparent/.opencode/plugin/m.js'],
    'wtparent/wt': ['wtparent/wt/.opencode/plugin/link.js', 'wtparent/wt/.opencode/plugin/m.js'],
    fake: ['fake/.opencode/plugin/m.js', 'fake/opencode.json = ?'], // 깨진 설정 — 엔진은 버리지만 넓게 잡는다
    'fake/proj': ['fake/proj/.opencode/plugin/m.js'],
    'fake/proj/deep': ['fake/proj/deep/.opencode/plugin/m.js'],
    ng: ['ng/.opencode/plugin/m.js', 'ng/opencode.jsonc = ?'],
    'ng/proj': ['ng/proj/.opencode/plugin/m.js'],
    home: ['home/.opencode/plugin/m.js'],
    'home/hp': ['home/hp/.opencode/plugin/m.js'],
  }
  const expected = (session: string): string[] => {
    const out: string[] = []
    for (let dir = session; ; dir = path.dirname(dir) === '.' ? '' : path.dirname(dir)) {
      out.push(...(OWN[dir] ?? []))
      if (dir === '') return out.sort()
    }
  }
  const show = (hit: EnginePluginHit): string =>
    `${path.relative(R, hit.path)}${hit.kind === 'config-entry' ? ` = ${hit.entry}` : hit.kind === 'config-unparsed' ? ' = ?' : ''}`
  const inR: EnginePluginIo = { ...jailed, readdir: (dir) => (dir === R || dir.startsWith(R + path.sep) ? fsp.readdir(dir) : Promise.reject(new Error('ENOENT'))) }

  it.each(['outer/repo/sub', 'outer/repo', 'outer/repo/inner', 'wtparent/wt', 'fake/proj/deep', 'ng/proj', 'home/hp', 'home/gitp', 'clean/proj'])('%s', async (session) => {
    const hits = await findEnginePlugins(p(session), undefined, inR)
    expect(hits.map(show).sort()).toEqual(expected(session))
  })
})

describe('describeEnginePlugins', () => {
  it('경로(설정 항목은 값까지)를 나열하고, 많으면 앞의 다섯 개와 나머지 수', () => {
    const file = (name: string): EnginePluginHit => ({ path: `/r/.opencode/plugin/${name}`, kind: 'file', where: 'project' })
    expect(describeEnginePlugins([file('a.js'), { path: '/r/opencode.json', kind: 'config-entry', where: 'project', entry: './p.js' }, { path: '/opencode.jsonc', kind: 'config-unparsed', where: 'above' }])).toBe(
      '/r/.opencode/plugin/a.js, /r/opencode.json ("./p.js"), /opencode.jsonc',
    )
    expect(describeEnginePlugins(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => file(`${name}.js`)))).toBe(
      '/r/.opencode/plugin/a.js, /r/.opencode/plugin/b.js, /r/.opencode/plugin/c.js, /r/.opencode/plugin/d.js, /r/.opencode/plugin/e.js (+2)',
    )
  })
})

describe('removeAppPluginDirs', () => {
  it('앱 설정 폴더의 plugin·plugins(대소문자 무시)만 지운다 — 설정·스킬·설치 표식은 그대로', () => {
    const base = plant({ 'config/plugin/x.js': '', 'config/PLUGINS/y.ts': '', 'config/opencode.json': '{}', 'config/skills/a/SKILL.md': '', 'config/node_modules': null })
    const dir = path.join(base, 'config')
    removeAppPluginDirs(dir)
    expect(fs.readdirSync(dir).sort()).toEqual(['node_modules', 'opencode.json', 'skills'])
  })

  it('없는 폴더면 아무 일도 없다', () => {
    expect(() => removeAppPluginDirs(path.join(ROOT, 'no-such-config'))).not.toThrow()
  })
})
