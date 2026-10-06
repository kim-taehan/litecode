import { describe, expect, it } from 'vitest'
import { maskCredentials } from '../../renderer/McpPopup.tsx'

describe('maskCredentials', () => {
  it('접속 문자열의 비밀번호를 가리고 나머지는 그대로 둔다', () => {
    expect(maskCredentials('npx -y @modelcontextprotocol/server-postgres postgresql://davis_admin:s3cret@db.internal:5432/davis')).toBe(
      'npx -y @modelcontextprotocol/server-postgres postgresql://davis_admin:••••@db.internal:5432/davis',
    )
    expect(maskCredentials('https://user:pw@example.com/mcp')).toBe('https://user:••••@example.com/mcp')
  })

  it('비밀번호가 없는 주소·명령은 건드리지 않는다', () => {
    for (const text of ['uvx --python 3.11 langfuse-mcp', 'https://example.com/mcp', 'https://user@example.com/mcp', 'npx foo@latest', 'a@b.c']) {
      expect(maskCredentials(text)).toBe(text)
    }
    expect(maskCredentials(undefined)).toBeUndefined()
  })
})
