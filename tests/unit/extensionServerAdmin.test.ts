import { describe, expect, it } from 'vitest'
import { prepareSonarAdmin, sonarPassword, type AdminSecrets } from '../../src/services/extensions/serverAdmin.ts'

// 내장 SonarQube 의 관리자 준비 (이슈 #537 1단계) — 첫 기동 때 admin 기본 비밀번호(admin)를 무작위로 바꾸고 User Token 을 만든다.
// 가짜 fetch 가 실측한 SonarQube 26.10 의 응답을 흉내 낸다 (_workspace/01_probe_537.md §5): 틀린 자격으로 validate 하면 200 {"valid":false},
// 인증 실패한 POST 는 401, 이미 바뀐 비밀번호를 admin 으로 바꾸려 하면 400 old_password_incorrect, 같은 이름 토큰은 400

class FakeSonar {
  password = 'admin'
  tokens = new Map<string, string>()
  calls: string[] = []
  minted = 0

  private who(headers: Headers): 'admin' | undefined {
    const auth = headers.get('authorization') ?? ''
    if (auth.startsWith('Bearer ')) return [...this.tokens.values()].includes(auth.slice(7)) ? 'admin' : undefined
    if (!auth.startsWith('Basic ')) return undefined
    const [login, password] = Buffer.from(auth.slice(6), 'base64').toString().split(':')
    return login === 'admin' && password === this.password ? 'admin' : undefined
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    const method = init?.method ?? 'GET'
    this.calls.push(`${method} ${url.pathname}`)
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
    const user = this.who(headers)
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

    if (url.pathname === '/api/authentication/validate') return json(200, { valid: user !== undefined })
    if (method !== 'POST') return new Response(null, { status: 405 })
    if (headers.get('content-type') !== 'application/x-www-form-urlencoded') return new Response(null, { status: 415 })
    if (user === undefined) return new Response(null, { status: 401 })
    if (url.pathname === '/api/users/change_password') {
      if (form.get('previousPassword') !== this.password) return json(400, { result: 'old_password_incorrect' })
      if ((form.get('password') ?? '').length < 12) return json(400, { result: 'Password must be at least 12 characters long' })
      this.password = form.get('password')!
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/api/user_tokens/revoke') {
      this.tokens.delete(form.get('name')!)
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/api/user_tokens/generate') {
      const name = form.get('name')!
      if (this.tokens.has(name)) return json(400, { errors: [{ msg: 'already exists' }] })
      if (form.get('type') !== 'USER_TOKEN') return json(400, { errors: [{ msg: 'type' }] })
      const token = `squ_${++this.minted}`
      this.tokens.set(name, token)
      return json(200, { login: 'admin', name, token, type: 'USER_TOKEN' })
    }
    return new Response(null, { status: 404 })
  }
}

function prepare(sonar: FakeSonar, secrets: AdminSecrets, saved: AdminSecrets[] = []) {
  let n = 0
  return prepareSonarAdmin({
    baseUrl: 'http://127.0.0.1:9000',
    fetch: sonar.fetch,
    secrets,
    save: async (next) => void saved.push(next),
    newPassword: () => `Generated-pw-${++n}aA1!`,
    tokenName: 'litecode',
  })
}

describe('prepareSonarAdmin', () => {
  it('첫 기동: 비밀번호를 먼저 저장하고 바꾼 뒤 토큰을 만들어 저장한다 (기본 비밀번호는 더 안 통한다)', async () => {
    const sonar = new FakeSonar()
    const saved: AdminSecrets[] = []
    expect(await prepare(sonar, {}, saved)).toEqual({ ok: true, token: 'squ_1' })
    expect(sonar.password).toBe('Generated-pw-1aA1!')
    // 바꾸기 전에 저장한다 — 바꾼 직후 앱이 죽어도 다음 기동이 새 비밀번호를 안다
    expect(saved).toEqual([{ password: 'Generated-pw-1aA1!' }, { password: 'Generated-pw-1aA1!', token: 'squ_1' }])
    expect(sonar.calls.indexOf('POST /api/users/change_password')).toBeLessThan(sonar.calls.indexOf('POST /api/user_tokens/generate'))
  })

  it('저장된 토큰이 살아 있으면 아무것도 바꾸지 않는다', async () => {
    const sonar = new FakeSonar()
    sonar.password = 'Stored-password-aA1!'
    sonar.tokens.set('litecode', 'squ_kept')
    const saved: AdminSecrets[] = []
    expect(await prepare(sonar, { password: 'Stored-password-aA1!', token: 'squ_kept' }, saved)).toEqual({ ok: true, token: 'squ_kept' })
    expect(saved).toEqual([])
    expect(sonar.calls).toEqual(['GET /api/authentication/validate'])
  })

  it('토큰이 죽었으면(취소됨) 저장된 비밀번호로 같은 이름을 지우고 새로 만든다', async () => {
    const sonar = new FakeSonar()
    sonar.password = 'Stored-password-aA1!'
    sonar.tokens.set('litecode', 'squ_other') // 이름은 남아 있다 — 지우지 않으면 400 already exists
    const saved: AdminSecrets[] = []
    expect(await prepare(sonar, { password: 'Stored-password-aA1!', token: 'squ_revoked' }, saved)).toEqual({ ok: true, token: 'squ_1' })
    expect(sonar.password).toBe('Stored-password-aA1!')
    expect(saved).toEqual([{ password: 'Stored-password-aA1!', token: 'squ_1' }])
  })

  it('비밀번호를 저장만 하고 바꾸기 전에 끊겼으면(서버는 아직 admin) 저장된 비밀번호로 바꾼다', async () => {
    const sonar = new FakeSonar()
    expect(await prepare(sonar, { password: 'Saved-before-crash-aA1!' })).toEqual({ ok: true, token: 'squ_1' })
    expect(sonar.password).toBe('Saved-before-crash-aA1!')
  })

  it('저장된 비밀번호도 기본 비밀번호도 안 통하면 admin-locked (누가 웹 화면에서 바꿨다)', async () => {
    const sonar = new FakeSonar()
    sonar.password = 'Changed-by-hand-aA1!'
    expect(await prepare(sonar, { password: 'Stale-password-aA1!' })).toEqual({ ok: false, error: 'admin-locked' })
    expect(sonar.calls.filter((call) => call.startsWith('POST'))).toEqual([])
  })

  it('서버가 비밀번호 바꾸기를 거절하면 admin-http (상태 코드를 싣는다)', async () => {
    const sonar = new FakeSonar()
    const short = await prepareSonarAdmin({
      baseUrl: 'http://127.0.0.1:9000',
      fetch: sonar.fetch,
      secrets: {},
      save: async () => {},
      newPassword: () => 'short',
      tokenName: 'litecode',
    })
    expect(short).toEqual({ ok: false, error: 'admin-http', status: 400, step: 'change-password' })
  })

  it('요청 자체가 실패하면 admin-unreachable — 던지지 않는다', async () => {
    const result = await prepareSonarAdmin({
      baseUrl: 'http://127.0.0.1:9000',
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
      secrets: {},
      save: async () => {},
      newPassword: () => 'Generated-pw-aA1!',
      tokenName: 'litecode',
    })
    expect(result).toEqual({ ok: false, error: 'admin-unreachable' })
  })

  // 저장 못 한 비밀번호로 바꾸면 다음 기동이 그 비밀번호를 모른다 (admin-locked 로 굳는다)
  it('비밀번호 저장이 던지면 바꾸지 않고 그대로 던진다', async () => {
    const sonar = new FakeSonar()
    const run = prepareSonarAdmin({
      baseUrl: 'http://127.0.0.1:9000',
      fetch: sonar.fetch,
      secrets: {},
      save: async () => {
        throw new Error('safeStorage unavailable')
      },
      newPassword: () => 'Generated-pw-aA1!',
      tokenName: 'litecode',
    })
    await expect(run).rejects.toThrow('safeStorage unavailable')
    expect(sonar.password).toBe('admin')
  })
})

describe('sonarPassword', () => {
  // SonarQube 비밀번호 규칙: 12자 이상, 대·소문자·숫자·특수문자 (실측: 짧으면 400 "at least 12 characters")
  it('규칙을 늘 만족하고 매번 다르다', () => {
    const a = sonarPassword()
    expect(a.length).toBeGreaterThanOrEqual(12)
    expect(a).toMatch(/[A-Z]/)
    expect(a).toMatch(/[a-z]/)
    expect(a).toMatch(/[0-9]/)
    expect(a).toMatch(/[^A-Za-z0-9]/)
    expect(sonarPassword()).not.toBe(a)
  })
})
