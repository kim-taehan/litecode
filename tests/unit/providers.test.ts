import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { ProviderRegistry } from '../../src/services/providers.ts'

const config = {
  id: 'gw',
  displayName: 'Gateway',
  baseURL: 'http://gw/v1',
  protocol: 'openai-chat-completions' as const,
  models: [{ id: 'm1', displayName: 'Model 1' }],
}

async function registry(): Promise<ProviderRegistry> {
  const ctx = new Context()
  ctx.plugin(ProviderRegistry)
  return new Promise((resolve) => ctx.inject(['providers'], (ready) => resolve(ready.providers)))
}

describe('ProviderRegistry', () => {
  it('등록한 provider 를 id 로 찾고, 반환된 함수로 등록을 되돌린다', async () => {
    const providers = await registry()
    const unregister = providers.register(config)

    expect(providers.get('gw')).toEqual(config)
    unregister()
    expect(providers.get('gw')).toBeUndefined()
  })

  it('없는 provider 의 모델 조회는 실패한다', async () => {
    const providers = await registry()

    await expect(providers.fetchAvailableModels('nope')).rejects.toThrow('unknown provider')
  })
})
