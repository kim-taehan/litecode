import fs from 'node:fs/promises'
import path from 'node:path'

// 확장이 담아 온 스킬 (이슈 #561) — manifest `skills` 의 폴더(그 안의 SKILL.md)를 앱 스킬 폴더(<userData>/opencode/skills)에 물질화한다.
// 내장 디자인 스킬(designSkill.ts)과 같은 길: 엔진은 폴더의 파일로 스킬을 보므로, 확장이 켜져 있으면 쓰고 꺼지거나 지워지면 지운다.
// 우리가 쓴 폴더에는 표식 파일(.litecode-extension, 확장 id)을 둔다 — 표식이 없는 같은 이름 폴더(사용자·다른 출처의 스킬)는 건드리지 않는다.
// 확장의 JS 를 실행하는 것이 아니다 — 모델이 읽는 글(SKILL.md)을 옮길 뿐이다

/** 스킬 이름 = 폴더 이름 — 엔진의 스킬 이름 규칙(소문자·숫자·-)과 같게 */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,40}$/
const MARK = '.litecode-extension'

export interface WantedSkill {
  /** 확장 id */
  id: string
  name: string
  /** 설치된 확장 안의 SKILL.md (절대 경로) */
  file: string
}

/** 앱 스킬 폴더를 원하는 목록에 맞춘다 — 바뀐 것이 있으면 true (엔진을 다시 띄워 목록을 다시 읽게) */
export async function syncExtensionSkills(dir: string, wanted: readonly WantedSkill[]): Promise<boolean> {
  let changed = false
  const owner = async (name: string): Promise<string | undefined> => fs.readFile(path.join(dir, name, MARK), 'utf8').catch(() => undefined)
  // 우리가 쓴 것 중 더는 원하지 않는 것을 지운다
  const present = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of present) {
    if (!entry.isDirectory()) continue
    const id = await owner(entry.name)
    if (id === undefined || wanted.some((skill) => skill.name === entry.name && skill.id === id)) continue
    await fs.rm(path.join(dir, entry.name), { recursive: true, force: true })
    changed = true
  }
  for (const skill of wanted) {
    const target = path.join(dir, skill.name)
    const id = await owner(skill.name)
    const exists = await fs.stat(target).then(() => true, () => false)
    if (exists && id !== skill.id) {
      console.warn(`[extensions] 스킬 ${skill.name} 은 이미 다른 것이 있어 ${skill.id} 의 것을 두지 않는다`)
      continue
    }
    const body = await fs.readFile(skill.file, 'utf8').catch(() => undefined)
    if (body === undefined) continue
    const current = await fs.readFile(path.join(target, 'SKILL.md'), 'utf8').catch(() => undefined)
    if (current === body && id === skill.id) continue
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, 'SKILL.md'), body)
    await fs.writeFile(path.join(target, MARK), skill.id)
    changed = true
  }
  return changed
}
