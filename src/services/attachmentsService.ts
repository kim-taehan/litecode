import path from 'node:path'
import { Context, Service } from 'cordis'
import './chat.ts' // ctx.chat · 'chat/attachments-read' 선언
import './sessions.ts' // 'sessions/removed' 선언
import type { AttachmentKind, AttachmentPick } from '../../shared/contract.ts'
import { tr } from '../i18n.ts'
import { attachDropped, attachPasted, pickAttachments } from './attachments.ts'
import { PastedImages } from './pastedImages.ts'

// 첨부를 칩으로 만드는 곳 (ctx.attachments, 이슈 #97 — electron/main.ts 의 chatBridge 본문에 있던 것을 옮겼다. 동작은 같다).
// - 고르기(`+` 메뉴, 이슈 #44) · 놓기·붙여넣기(이슈 #80): 종류·상한·사유는 attachments.ts 의 검사로 메인이 정하고,
//   **칩이 된 경로만** ctx.chat 에 적어 둔다(allowAttachments) — 보낼 때 그 안의 것만 읽힌다
// - 경로 없는 이미지(스크린숏)의 임시 파일을 쥔다 (pastedImages.ts — 지우는 때: 보낸 뒤·칩 삭제·대화 삭제·서비스가 뜰 때와 내려갈 때 폴더째)
// Electron 을 모른다 — OS 파일 고르기는 host 로 받는다 (electron/attachmentsHost.ts).

/** OS 파일 고르기에 넘기는 것 (여러 개 고르기) */
export interface ChooseFilesRequest {
  /** 이 종류만 보이게 — 없으면 모든 파일 */
  filters?: { name: string; extensions: string[] }[]
  /** 처음 열 폴더 */
  defaultPath?: string
}

/** 창·OS 쪽 — 메인이 Electron 으로 채운다 */
export interface AttachmentsHost {
  /** 파일 고르기를 띄운다 — 취소면 undefined. owner 는 다리가 준 그대로다(대화상자를 붙일 창을 host 가 찾는다) */
  chooseFiles(request: ChooseFilesRequest, owner?: unknown): Promise<string[] | undefined>
}

export interface AttachmentsOptions {
  host: AttachmentsHost
  /** 붙여넣은 이미지를 두는 폴더 — 이 서비스만 쓴다 (뜰 때·내려갈 때 통째로 비운다) */
  pastedDir: string
}

declare module 'cordis' {
  interface Context {
    attachments: AttachmentsService
  }
}

export class AttachmentsService extends Service {
  static readonly inject = ['chat']

  private pasted: PastedImages
  /** 뜰 때의 폴더 비우기 — 붙여넣기는 이것이 끝난 뒤에 파일을 둔다 */
  private cleared: Promise<void>

  constructor(
    ctx: Context,
    private opts: AttachmentsOptions,
  ) {
    super(ctx, 'attachments')
    this.pasted = new PastedImages(opts.pastedDir)
    this.cleared = this.pasted.reset().catch((error: unknown) => console.error('[attachments] 붙여넣은 이미지 폴더 비우기 실패', (error as Error).message))
    ctx.effect(() => () => this.pasted.reset().catch(() => {}))
    ctx.on('chat/attachments-read', (paths) => void this.pasted.discard(paths))
    ctx.on('sessions/removed', (ids) => void this.pasted.discardOf(ids))
  }

  /** `+` 메뉴의 파일 추가·이미지 추가 — 이미지는 png·jpeg 만 (01y: 그 밖은 실측하지 않았다. 판정은 확장자가 아니라 매직 바이트).
   *  held 는 그 메시지에 이미 붙은 같은 종류의 수 */
  async pick(kind: AttachmentKind, directory: unknown, held: unknown, owner?: unknown): Promise<AttachmentPick> {
    const image = kind === 'image'
    const chosen = await this.opts.host.chooseFiles(
      image ? { filters: [{ name: tr('attach.imageFilter'), extensions: ['png', 'jpg', 'jpeg'] }] } : { ...(typeof directory === 'string' && { defaultPath: directory }) },
      owner,
    )
    if (!chosen) return { picked: [], rejected: [] }
    const result = await pickAttachments(image ? 'image' : 'file', chosen, Number(held) || 0)
    this.ctx.chat.allowAttachments(result.picked.map((item) => item.path))
    return result
  }

  /** 붙여넣기·끌어다 놓기. 본문은 preload 가 File 객체에서 만든 것이다 — paths: 사용자가 실제로 놓거나 붙여넣은 파일의 경로
   *  (webUtils.getPathForFile), blobs: 경로 없는 이미지의 바이트(스크린숏). 경로 없는 이미지는 임시 파일이 된다 */
  async drop(
    conversationId: string,
    input: { paths?: unknown; blobs?: unknown } | undefined,
    held: Partial<Record<AttachmentKind, number>> | undefined,
    model: { providerId: string; modelId: string } | undefined,
  ): Promise<AttachmentPick> {
    await this.cleared
    const paths = Array.isArray(input?.paths) ? input.paths.filter((file): file is string => typeof file === 'string' && path.isAbsolute(file)) : []
    const blobs = (Array.isArray(input?.blobs) ? (input.blobs as { name?: unknown; data?: unknown }[]) : []).map((blob) => ({
      name: String(blob?.name ?? ''),
      ...(blob?.data instanceof Uint8Array && { data: blob.data }),
    }))
    const imageInput = typeof model === 'object' && this.ctx.chat.acceptsImages(model)
    const count = { file: Number(held?.file) || 0, image: Number(held?.image) || 0 }
    const dropped = await attachDropped(paths, count, imageInput)
    for (const item of dropped.picked) count[item.kind]++
    const fromBytes = await attachPasted(this.pasted, String(conversationId), blobs, count, imageInput)
    const picked = [...dropped.picked, ...fromBytes.picked]
    this.ctx.chat.allowAttachments(picked.map((item) => item.path))
    return { picked, rejected: [...new Set([...dropped.rejected, ...fromBytes.rejected])] }
  }

  /** 칩을 뺐다 — 그 경로들을 보내기 허용 목록에서 빼고(ctx.chat), 이 서비스가 만든 임시 파일만 지운다 (고른·놓은 파일은 건드리지 않는다) */
  async discard(paths: unknown): Promise<void> {
    const files = Array.isArray(paths) ? paths.filter((file): file is string => typeof file === 'string') : []
    this.ctx.chat.revokeAttachments(files)
    await this.pasted.discard(files)
  }
}
