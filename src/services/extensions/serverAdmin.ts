import { randomBytes } from 'node:crypto'

// 내장 SonarQube 의 관리자 준비 (이슈 #537) — 첫 기동 때 admin 기본 비밀번호(admin)를 무작위로 바꾸고 User Token 을 만든다.
// 저장(safeStorage)은 부르는 쪽이 save 로 한다. 근거 실측은 _workspace/01_probe_537.md §5 (SonarQube 26.10):
// - 자격은 Basic admin:<비밀번호>, 토큰은 Bearer <토큰> 둘 다 통한다. 틀린 자격의 GET api/authentication/validate 는 200 {"valid":false}
// - POST api/users/change_password(login·previousPassword·password, 폼) → 204. 이미 바뀐 뒤 previousPassword=admin 이면 400 old_password_incorrect
// - POST api/user_tokens/generate(name·type=USER_TOKEN) → 200 {token}. 같은 이름이 있으면 400 — 그래서 만들기 전에 그 이름을 revoke 한다
// - 기본 비밀번호 그대로도 토큰은 만들어진다 — 그래도 비밀번호를 먼저 바꾼다(127.0.0.1 이라도 같은 기기의 다른 프로그램이 admin/admin 으로 들어온다)
// 순서: 바꾸기 전에 새 비밀번호를 먼저 저장한다 — 바꾼 직후 앱이 죽어도 다음 기동이 그 비밀번호를 안다

const DEFAULT_PASSWORD = 'admin'

export interface AdminSecrets {
  password?: string
  token?: string
}

export interface SonarAdminOptions {
  /** http://127.0.0.1:<port> */
  baseUrl: string
  fetch: typeof globalThis.fetch
  /** 앞서 저장해 둔 것 */
  secrets: AdminSecrets
  /** 바뀐 비밀(비밀번호만 / 비밀번호+토큰)을 저장한다 — 던지면 그대로 던진다(저장 못 한 비밀번호로 바꾸지 않는다) */
  save(secrets: AdminSecrets): Promise<void>
  newPassword(): string
  tokenName: string
}

/** admin-locked: 저장된 비밀번호도 기본 비밀번호도 안 통한다(누가 웹 화면에서 바꿨다) · admin-http: 서버가 거절 · admin-unreachable: 요청 자체가 실패 */
export type SonarAdminResult =
  | { ok: true; token: string }
  | { ok: false; error: 'admin-locked' }
  | { ok: false; error: 'admin-http'; status: number; step: 'change-password' | 'generate-token' }
  | { ok: false; error: 'admin-unreachable' }

/** SonarQube 비밀번호 규칙(12자 이상, 대·소문자·숫자·특수문자)을 늘 만족하는 무작위 글 */
export function sonarPassword(): string {
  return `${randomBytes(24).toString('base64url')}aA1!`
}

/** 요청이 서버에 못 닿았다 — save 가 던진 것과 가르려고 따로 둔다 */
const UNREACHABLE = Symbol('unreachable')

export async function prepareSonarAdmin(opts: SonarAdminOptions): Promise<SonarAdminResult> {
  const send = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await opts.fetch(url, init)
    } catch {
      throw UNREACHABLE
    }
  }
  const basic = (password: string): string => `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`
  const valid = async (authorization: string): Promise<boolean> => {
    const res = await send(`${opts.baseUrl}/api/authentication/validate`, { headers: { authorization } })
    return res.ok && ((await res.json().catch(() => ({}))) as { valid?: unknown }).valid === true
  }
  const post = (pathname: string, password: string, form: Record<string, string>): Promise<Response> =>
    send(`${opts.baseUrl}${pathname}`, {
      method: 'POST',
      headers: { authorization: basic(password), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    })

  try {
    if (opts.secrets.token !== undefined && (await valid(`Bearer ${opts.secrets.token}`))) return { ok: true, token: opts.secrets.token }

    let password = opts.secrets.password
    if (password === undefined || !(await valid(basic(password)))) {
      if (!(await valid(basic(DEFAULT_PASSWORD)))) return { ok: false, error: 'admin-locked' }
      // 저장만 하고 바꾸기 전에 끊긴 비밀번호가 있으면 그것으로 바꾼다
      password ??= opts.newPassword()
      await opts.save({ password })
      const changed = await post('/api/users/change_password', DEFAULT_PASSWORD, { login: 'admin', previousPassword: DEFAULT_PASSWORD, password })
      if (!changed.ok) return { ok: false, error: 'admin-http', status: changed.status, step: 'change-password' }
    }

    await post('/api/user_tokens/revoke', password, { name: opts.tokenName }) // 없는 이름이어도 된다 — 결과는 아래 generate 가 말한다
    const generated = await post('/api/user_tokens/generate', password, { name: opts.tokenName, type: 'USER_TOKEN' })
    if (!generated.ok) return { ok: false, error: 'admin-http', status: generated.status, step: 'generate-token' }
    const { token } = (await generated.json().catch(() => ({}))) as { token?: unknown }
    if (typeof token !== 'string' || token === '') return { ok: false, error: 'admin-http', status: generated.status, step: 'generate-token' }
    await opts.save({ password, token })
    return { ok: true, token }
  } catch (error) {
    if (error === UNREACHABLE) return { ok: false, error: 'admin-unreachable' }
    throw error
  }
}
