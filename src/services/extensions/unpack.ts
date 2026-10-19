import fs from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { EXTENSION_LIMITS, type ExtensionLimits } from './limits.ts'
import { isFinderJunk, isSymlink, listItems, locateManifest, namesOf, openZip, pipeEntry } from './zipInspect.ts'
import { unsafePathReason } from './paths.ts'

// 확장 zip 풀기 (이슈 #480, 설계 4절 "설치(install)") — inspectZip 을 통과한 zip 만 부르지만 검사 결과를 믿지 않고 이름·종류를 항목마다 다시 본다.
// 단일 최상위 폴더 안에 extension.json 이 있으면 그 래퍼 폴더를 벗겨 dest 바로 아래에 푼다. Finder 부산물(__MACOSX/·.DS_Store)은 건너뛴다.
// 크기는 선언값이 아니라 실제로 흘러나온 바이트로 다시 센다 — 상한(limits)과, 선언 해제 크기와의 불일치(크든 작든)를 여기서 직접 거절한다.
// 압축 해제와 선언 크기 대조는 pipeEntry(zipInspect.ts)가 한다 — yauzl 의 압축 해제 스트림을 쓰지 않는 이유도 거기 적었다(이슈 #480 QA 차단).
// 실패하면 던진다 — dest 정리는 부르는 쪽(store.install)이 한다

export async function unpackZip(file: string, dest: string, limits: ExtensionLimits = EXTENSION_LIMITS): Promise<void> {
  const zip = await openZip(file)
  try {
    const items = (await listItems(zip)).filter((item) => !isFinderJunk(item.name))
    const located = locateManifest(items)
    if ('problem' in located) throw new Error(located.problem.code)
    await fs.promises.mkdir(dest, { recursive: true })

    let totalBytes = 0
    for (const item of items) {
      for (const name of namesOf(item.entry, item.name)) {
        const reason = unsafePathReason(name)
        if (reason) throw new Error(`unsafe path ${JSON.stringify(name)} (${reason})`)
      }
      if (isSymlink(item.entry)) throw new Error(`symlink ${JSON.stringify(item.name)}`)
      const relative = item.name.slice(located.root.length)
      if (relative === '') continue
      const target = path.resolve(dest, relative)
      if (!target.startsWith(dest + path.sep)) throw new Error(`outside ${JSON.stringify(item.name)}`)

      if (item.isDir) {
        await fs.promises.mkdir(target, { recursive: true })
        continue
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true })
      let fileBytes = 0
      await pipeEntry(
        zip,
        item,
        new Transform({
          transform(chunk: Buffer, _encoding, done) {
            fileBytes += chunk.length
            totalBytes += chunk.length
            if (fileBytes > limits.fileBytes) return done(new Error(`${item.name} exceeds ${limits.fileBytes} bytes`))
            if (totalBytes > limits.totalBytes) return done(new Error(`total exceeds ${limits.totalBytes} bytes`))
            done(null, chunk)
          },
        }),
        // wx — 이미 있는 이름(중복 항목)은 덮지 않고 실패한다
        fs.createWriteStream(target, { flags: 'wx' }),
      )
    }
  } finally {
    zip.close()
  }
}
