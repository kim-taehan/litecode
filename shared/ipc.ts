// 렌더러 ↔ 메인 IPC 계약. 채널 이름과 페이로드 모양을 한 곳에 둔다.
// 타입은 서비스 쪽 정의를 그대로 재수출한다 — 같은 모양을 두 곳에 베끼지 않는다.

import type { ProviderConfig } from '../src/services/providers.ts'
import type { ChatResult } from '../src/services/llm.ts'
import type { Project } from '../src/services/projects.ts'

export type { ProviderConfig, ModelCatalogEntry } from '../src/services/providers.ts'
export type { ChatResult } from '../src/services/llm.ts'
export type { Project } from '../src/services/projects.ts'

export const Channel = {
  LIST_PROVIDERS: 'providers:list',
  SEND_MESSAGE: 'chat:send',
  LIST_PROJECTS: 'projects:list',
  OPEN_PROJECT: 'projects:open',
  PICK_PROJECT_FOLDER: 'projects:pick-folder',
  SET_PROJECT_FAVORITE: 'projects:set-favorite',
  REMOVE_PROJECT: 'projects:remove',
} as const

export interface LitecodeBridge {
  listProviders(): Promise<ProviderConfig[]>
  /** sessionId 를 안 주면 directory(작업 디렉터리)에서 세션을 새로 만든다 — 결과의 sessionId 를 다음 호출에 넘긴다 */
  sendMessage(providerId: string, modelId: string, directory: string, prompt: string, sessionId?: string): Promise<ChatResult>
  /** 최근 프로젝트 — 맨 앞이 마지막으로 연 프로젝트 */
  listProjects(): Promise<Project[]>
  /** 그 폴더를 열어 최근 목록 맨 앞에 올린다 */
  openProject(directory: string): Promise<Project>
  /** OS 폴더 대화상자로 골라 연다. 취소하면 undefined */
  pickProjectFolder(): Promise<Project | undefined>
  /** 즐겨찾기 표시를 바꾸고 바뀐 목록을 준다 */
  setProjectFavorite(directory: string, favorite: boolean): Promise<Project[]>
  /** 목록에서만 뺀다(폴더는 그대로) — 바뀐 목록을 준다 */
  removeProject(directory: string): Promise<Project[]>
}

declare global {
  interface Window {
    litecode: LitecodeBridge
  }
}
