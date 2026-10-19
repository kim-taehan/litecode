import fs from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import type yauzl from 'yauzl'
import { EXTENSION_LIMITS, type ExtensionLimits } from './limits.ts'
import { isFinderJunk, isSymlink, listItems, locateManifest, namesOf, openZip } from './zipInspect.ts'
import { unsafePathReason } from './paths.ts'

// 확장 zip 풀기 (이슈 #480, 설계 4절 "설치(install)") — inspectZip 을 통과한 zip 만 부르지만 검사 결과를 믿지 않고 이름·종류를 항목마다 다시 본다.
// 단일 최상위 폴더 안에 extension.json 이 있으면 그 래퍼 폴더를 벗겨 dest 바로 아래에 푼다. Finder 부산물(__MACOSX/·.DS_Store)은 건너뛴다.
// 크기는 선언값이 아니라 실제로 흘러나온 바이트로 다시 센다 — 상한(limits)과, 선언 해제 크기와의 불일치(크든 작든)를 여기서 직접 거절한다.
// 압축은 yauzl 에 맡기지 않고(decompress:false 로 원본 바이트만 받는다) 직접 푼다: yauzl 2.10 이 압축 항목에 돌려주는 스트림은 destroy 를
// 자기 함수로 덮어써 오류·close 를 내지 않아, 크기 검증(AssertByteCountStream)이 어긋나면 pipeline 이 영영 끝나지 않았다(이슈 #480 QA 차단).
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
      const declared = item.entry.uncompressedSize
      let fileBytes = 0
      const raw = await openRawStream(zip, item.entry)
      await pipeline(
        raw,
        // STORE 는 원본 바이트가 곧 내용이다 (yauzl 이 목록 단계에서 압축·해제 크기가 같은지 본다)
        item.entry.isCompressed() ? zlib.createInflateRaw() : new Transform({ transform: (chunk, _encoding, done) => done(null, chunk) }),
        new Transform({
          transform(chunk: Buffer, _encoding, done) {
            fileBytes += chunk.length
            totalBytes += chunk.length
            if (fileBytes > limits.fileBytes) return done(new Error(`${item.name} exceeds ${limits.fileBytes} bytes`))
            if (totalBytes > limits.totalBytes) return done(new Error(`total exceeds ${limits.totalBytes} bytes`))
            if (fileBytes > declared) return done(new Error(`${item.name} is larger than declared ${declared} bytes`))
            done(null, chunk)
          },
          flush(done) {
            done(fileBytes === declared ? null : new Error(`${item.name} is ${fileBytes} bytes, declared ${declared}`))
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

/** 항목의 원본(압축된) 바이트 — decompress 옵션은 압축 항목에만 줄 수 있다(yauzl 이 던진다) */
function openRawStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, stream: NodeJS.ReadableStream) => (error ? reject(error) : resolve(stream))
    // @types/yauzl 은 옵션을 모두 필수로 적는다 — yauzl 은 `!= null` 로 보므로 null 은 안 준 것과 같다
    if (entry.isCompressed()) zip.openReadStream(entry, { decompress: false, decrypt: null, start: null, end: null }, done)
    else zip.openReadStream(entry, done)
  })
}
