import type { Context } from 'cordis'
import '../hooks.ts'
import '../projects.ts'
import { tr } from '../../i18n.ts'
import { hookRow } from '../../../shared/hooks.ts'
import { Channel } from '../../../shared/ipc.ts'

// 훅 팝업의 IPC 다리 (이슈 #102 3단계 — 입력창 `+` 메뉴 > 훅). 기능 `hooks` 묶음 안에서 ctx.hooks 와 함께 올라가고 내려간다 —
// 기능이 꺼져 있으면 채널이 없고 화면도 부르지 않는다. 다리는 얇다: 채널 → ctx.hooks 의 메서드 (검증·판정은 서비스와 shared/hooks.ts).
// - directory 는 **등록된 프로젝트만** 받는다: 시험 실행은 그 폴더에서 명령을 돌리고 가져오기는 그 폴더의 파일을 읽는다 —
//   화면이 오염돼도 아무 폴더에서나 하지 않게 (skillsBridge 의 "폴더 열기" 와 같은 규칙)
// - Electron 을 모른다 — 채널을 거는 함수(handle)를 받는다 (electron/main.ts 의 handle, 테스트는 가짜 등록소)

export type BridgeHandle = (ctx: Context, channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => void

export function hooksBridge(handle: BridgeHandle): ((ctx: Context) => void) & { inject: string[] } {
  function bridge(ctx: Context): void {
    const project = async (directory: unknown): Promise<string> => {
      if (typeof directory !== 'string' || !(await ctx.projects.list()).some((entry) => entry.path === directory)) throw new Error(tr('hooks.error.project'))
      return directory
    }
    handle(ctx, Channel.LIST_HOOKS, async (_event, directory: unknown) => (await ctx.hooks.list(await project(directory))).map(hookRow))
    handle(ctx, Channel.SAVE_HOOK, async (_event, draft: unknown, directory: unknown) => ctx.hooks.saveHook(draft, await project(directory)))
    handle(ctx, Channel.REMOVE_HOOK, async (_event, scope: unknown, key: unknown, directory: unknown) =>
      ctx.hooks.removeHook(scope === 'all' ? 'all' : 'project', String(key), await project(directory)),
    )
    handle(ctx, Channel.SET_HOOK_ENABLED, async (_event, key: unknown, enabled: unknown, directory: unknown) =>
      ctx.hooks.setEnabled(await project(directory), String(key), enabled === true),
    )
    handle(ctx, Channel.TEST_HOOK, async (_event, draft: unknown, directory: unknown) => ctx.hooks.test(draft, await project(directory)))
    handle(ctx, Channel.HOOK_CANDIDATES, async (_event, directory: unknown) => ctx.hooks.candidates(await project(directory)))
    handle(ctx, Channel.IMPORT_HOOKS, async (_event, keys: unknown, directory: unknown) =>
      ctx.hooks.importHooks(await project(directory), Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : []),
    )
    handle(ctx, Channel.RECENT_HOOKS, async (_event, directory: unknown) => ctx.hooks.recentIn(await project(directory)))
  }
  bridge.inject = ['hooks', 'projects']
  return bridge
}
