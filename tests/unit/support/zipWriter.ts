import zlib from 'node:zlib'

// 테스트용 최소 zip 작성기 (확장 zip 검사, 이슈 #478) — 기본은 압축 없이(STORE) 쓴다(deflate·선언 크기 거짓은 항목 옵션, 이슈 #480). yazl 을 쓰지 않는 이유: yazl 은 `../x`·`/abs`·백슬래시 이름을
// 쓰기 전에 거절해서 zip-slip 항목을 만들 수 없다. 여기서는 이름(바이트 그대로)·external attributes(심볼릭 링크)·Info-ZIP 유니코드 경로 필드를 직접 준다

export interface ZipItem {
  /** 항목 이름 — 문자열은 UTF-8 로(플래그 0x800), 검사 우회 시험용 이름(널 문자·백슬래시)도 그대로 들어간다. 폴더는 `/` 로 끝낸다 */
  name: string
  data?: string
  /** 유닉스 모드 (external attributes 의 위 16비트) — 기본: 폴더 0o40755, 파일 0o100644. 심볼릭 링크는 0o120777 */
  mode?: number
  /** Info-ZIP Unicode Path Extra Field(0x7075)에 싣는 이름 — 풀 때 헤더 이름 대신 이것이 쓰인다 */
  unicodeName?: string
  /** deflate(방식 8)로 압축해 싣는다 — 기본은 STORE (이슈 #480) */
  deflate?: boolean
  /** 헤더에 적을 해제 크기 — 실제 데이터와 다르게 적어 크기 거짓 zip 을 만든다. deflate 항목에만 (STORE 는 yauzl 이 목록 단계에서 거절한다) */
  declaredSize?: number
}

export function makeZip(items: readonly ZipItem[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const item of items) {
    const name = Buffer.from(item.name, 'utf8')
    const data = Buffer.from(item.data ?? '', 'utf8')
    const crc = zlib.crc32(data)
    const stored = item.deflate ? zlib.deflateRawSync(data) : data
    const method = item.deflate ? 8 : 0
    const size = item.declaredSize ?? data.length
    const mode = item.mode ?? (item.name.endsWith('/') ? 0o40755 : 0o100644)
    const extra = item.unicodeName === undefined ? Buffer.alloc(0) : unicodePathField(name, item.unicodeName)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x800, 6) // UTF-8 이름
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(extra.length, 28)
    locals.push(local, name, extra, stored)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // made by: unix
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(stored.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(extra.length, 30)
    central.writeUInt32LE((mode << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name, extra)

    offset += local.length + name.length + extra.length + stored.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(items.length, 8)
  end.writeUInt16LE(items.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

function unicodePathField(headerName: Buffer, unicodeName: string): Buffer {
  const value = Buffer.from(unicodeName, 'utf8')
  const field = Buffer.alloc(4 + 5 + value.length)
  field.writeUInt16LE(0x7075, 0)
  field.writeUInt16LE(5 + value.length, 2)
  field.writeUInt8(1, 4) // version
  field.writeUInt32LE(zlib.crc32(headerName), 5)
  value.copy(field, 9)
  return field
}
