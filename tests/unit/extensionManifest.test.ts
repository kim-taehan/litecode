import { describe, expect, it } from 'vitest'
import { checkManifest, compareVersions } from '../../src/services/extensions/manifest.ts'

// 확장 manifest(extension.json) 검증 (이슈 #478, 설계 docs/superpowers/specs/2026-10-19-extension-install-design.md 3절).
// 거절 사유는 코드 + 변수로 모아 돌려준다 — 첫 사유에서 멈추지 않는다. 모르는 필드는 무시하지 않고 거절(오타 난 permissions 가 조용히 빠지지 않게)

const APP = '1.4.0'
const valid = { id: 'my-ext', name: '내 확장', description: '한 줄 설명', version: '1.0.0', entry: 'index.js' }

describe('checkManifest', () => {
  it('정상 manifest 는 사유 없이 manifest 를 돌려준다 (선택 필드 포함)', () => {
    const full = { ...valid, litecode: '1.2.0', permissions: ['network', 'secrets', 'project'] }
    expect(checkManifest(full, APP)).toEqual({ manifest: full, problems: [] })
    expect(checkManifest(valid, APP)).toEqual({ manifest: valid, problems: [] })
  })

  it('객체가 아니면 manifest-invalid', () => {
    for (const value of [null, [], 'x', 3]) {
      expect(checkManifest(value, APP).problems.map((p) => p.code)).toEqual(['manifest-invalid'])
    }
  })

  it('필수 필드가 없으면 각각 field-missing', () => {
    const result = checkManifest({}, APP)
    expect(result.manifest).toBeUndefined()
    expect(result.problems).toEqual(
      ['id', 'name', 'description', 'version', 'entry'].map((field) => ({ code: 'field-missing', params: { field } })),
    )
  })

  it.each(['ab', 'My-Ext', 'my_ext', 'a'.repeat(41), 'my ext', 'ünï'])('id 형식 위반: %s', (id) => {
    expect(checkManifest({ ...valid, id }, APP).problems).toEqual([{ code: 'id-invalid', params: { value: id } }])
  })

  it('id 3자·40자 경계는 통과', () => {
    expect(checkManifest({ ...valid, id: 'a-1' }, APP).problems).toEqual([])
    expect(checkManifest({ ...valid, id: 'a'.repeat(40) }, APP).problems).toEqual([])
  })

  it('기존 기능 id(FEATURES)와 같으면 id-reserved', () => {
    expect(checkManifest({ ...valid, id: 'git' }, APP).problems).toEqual([{ code: 'id-reserved', params: { value: 'git' } }])
  })

  it('name·description 은 비지 않은 문자열이고 길이 상한이 있다', () => {
    expect(checkManifest({ ...valid, name: '  ' }, APP).problems).toEqual([{ code: 'text-invalid', params: { field: 'name', max: 80 } }])
    expect(checkManifest({ ...valid, description: 'x'.repeat(301) }, APP).problems).toEqual([
      { code: 'text-invalid', params: { field: 'description', max: 300 } },
    ])
    expect(checkManifest({ ...valid, name: 3 }, APP).problems.map((p) => p.code)).toEqual(['text-invalid'])
  })

  it('details(선택, 이슈 #519): 여러 줄 문자열은 그대로 통과 — 문자열이 아니거나 비었거나 2000자를 넘으면 text-invalid', () => {
    const withDetails = { ...valid, details: '첫 줄\n둘째 줄\n\n셋째 줄' }
    expect(checkManifest(withDetails, APP)).toEqual({ manifest: withDetails, problems: [] })
    expect(checkManifest({ ...valid, details: 'x'.repeat(2000) }, APP).problems).toEqual([])
    for (const details of [3, ['a'], { a: 1 }, null, '  ', 'x'.repeat(2001)]) {
      expect(checkManifest({ ...valid, details }, APP).problems).toEqual([{ code: 'text-invalid', params: { field: 'details', max: 2000 } }])
    }
  })

  it.each(['1.0', 'v1.0.0', '01.0.0', '1.0.0-', '1.0.0.0', 'latest'])('잘못된 semver: %s', (version) => {
    expect(checkManifest({ ...valid, version }, APP).problems).toEqual([{ code: 'version-invalid', params: { field: 'version', value: version } }])
  })

  it('prerelease·build 가 붙은 semver 는 통과', () => {
    expect(checkManifest({ ...valid, version: '1.0.0-beta.2+build.7' }, APP).problems).toEqual([])
  })

  it('litecode(최소 앱 버전)가 semver 가 아니면 version-invalid, 앱보다 높으면 app-too-old', () => {
    expect(checkManifest({ ...valid, litecode: '>=1.0' }, APP).problems).toEqual([
      { code: 'version-invalid', params: { field: 'litecode', value: '>=1.0' } },
    ])
    expect(checkManifest({ ...valid, litecode: '1.5.0' }, APP).problems).toEqual([
      { code: 'app-too-old', params: { required: '1.5.0', current: APP } },
    ])
    expect(checkManifest({ ...valid, litecode: APP }, APP).problems).toEqual([])
  })

  it.each(['../index.js', '/abs/index.js', 'C:/index.js', 'C:\\index.js', 'lib\\..\\..\\x.js', 'a/../../x.js', '', './index.js', 'lib/', 'a\0b.js'])(
    'entry 경로 위반: %j',
    (entry) => {
      expect(checkManifest({ ...valid, entry }, APP).problems).toEqual([{ code: 'entry-invalid', params: { value: entry } }])
    },
  )

  it('하위 폴더의 entry 는 통과', () => {
    expect(checkManifest({ ...valid, entry: 'dist/main.js' }, APP).problems).toEqual([])
  })

  it('permissions 는 문자열 배열이어야 한다', () => {
    for (const permissions of ['fs', [1], [''], { a: 1 }]) {
      expect(checkManifest({ ...valid, permissions }, APP).problems).toEqual([{ code: 'permissions-invalid', params: {} }])
    }
    expect(checkManifest({ ...valid, permissions: [] }, APP).problems).toEqual([])
  })

  it('모르는 권한은 permission-unknown 으로 거절하고, 비슷한 이름이 있으면 suggestion (이슈 #536)', () => {
    expect(checkManifest({ ...valid, permissions: ['network', 'netwrok', 'Secrets', 'fs.read'] }, APP).problems).toEqual([
      { code: 'permission-unknown', params: { value: 'netwrok', suggestion: 'network' } },
      { code: 'permission-unknown', params: { value: 'Secrets', suggestion: 'secrets' } },
      { code: 'permission-unknown', params: { value: 'fs.read' } },
    ])
  })

  it('언어 팩(type locale)이 권한을 선언하면 permissions-unexpected — 빈 배열은 통과 (이슈 #536)', () => {
    const pack = { ...valid, type: 'locale', locale: { language: 'zh-CN', label: '中文' }, entry: 'locale.json' }
    expect(checkManifest({ ...pack, permissions: ['network'] }, APP).problems).toEqual([{ code: 'permissions-unexpected', params: {} }])
    expect(checkManifest({ ...pack, permissions: [] }, APP).problems).toEqual([])
  })

  it('모르는 필드는 거절하고, 비슷한 이름이 있으면 suggestion 을 싣는다', () => {
    expect(checkManifest({ ...valid, permisions: ['x'] }, APP).problems).toEqual([
      { code: 'field-unknown', params: { field: 'permisions', suggestion: 'permissions' } },
    ])
    expect(checkManifest({ ...valid, Version: '1.0.0' }, APP).problems).toEqual([
      { code: 'field-unknown', params: { field: 'Version', suggestion: 'version' } },
    ])
    expect(checkManifest({ ...valid, homepage: 'x' }, APP).problems).toEqual([{ code: 'field-unknown', params: { field: 'homepage' } }])
  })

  // 내장 서버 (이슈 #537) — 선언 검사 자체는 extensionServer.test.ts, 여기는 manifest 와의 연결만
  describe('server', () => {
    const server = { command: 'server/bin/java', args: ['-jar', 'x.jar'], port: 9000, health: { path: '/api/system/status', field: 'status', ready: 'UP' } }

    it('server 권한과 같이 있으면 통과하고 정규화된 선언(env 기본 {})을 싣는다', () => {
      const result = checkManifest({ ...valid, permissions: ['server'], server }, APP)
      expect(result.problems).toEqual([])
      expect(result.manifest?.server).toEqual({ ...server, env: {} })
    })

    it('선언만 있거나 권한만 있으면 server-mismatch', () => {
      expect(checkManifest({ ...valid, server }, APP).problems).toEqual([{ code: 'server-mismatch', params: {} }])
      expect(checkManifest({ ...valid, permissions: ['server'] }, APP).problems).toEqual([{ code: 'server-mismatch', params: {} }])
    })

    it('선언이 틀리면 server-invalid{field}', () => {
      expect(checkManifest({ ...valid, permissions: ['server'], server: { ...server, command: '../java' } }, APP).problems).toEqual([
        { code: 'server-invalid', params: { field: 'command' } },
      ])
      expect(checkManifest({ ...valid, permissions: ['server'], server: 'java -jar x.jar' }, APP).problems).toEqual([{ code: 'server-invalid', params: { field: 'shape' } }])
    })
  })

  it('여러 사유를 한 번에 모은다', () => {
    const result = checkManifest({ id: 'Bad', name: '', version: '1', entry: '../x', permisions: [] }, APP)
    expect(result.manifest).toBeUndefined()
    expect(result.problems.map((p) => p.code)).toEqual(['field-unknown', 'id-invalid', 'text-invalid', 'field-missing', 'version-invalid', 'entry-invalid'])
  })
})

describe('compareVersions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.1', '1.0.0', 1],
    ['1.2.0', '1.10.0', -1],
    ['2.0.0', '1.99.99', 1],
    ['1.0.0-alpha', '1.0.0', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1],
    ['1.0.0-rc.1', '1.0.0-beta.11', 1],
    ['1.0.0+build.1', '1.0.0+build.2', 0],
  ] as const)('%s vs %s → %i', (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b))).toBe(expected)
    expect(Math.sign(compareVersions(b, a))).toBe(expected === 0 ? 0 : -expected)
  })
})
