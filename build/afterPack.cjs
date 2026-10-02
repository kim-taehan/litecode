// mac 산출물에 코드 서명을 건다 (closed-code/desktop build/afterPack.cjs 를 옮겼다).
//
// 서명이 깨진 앱이 브라우저 다운로드 꼬리표(com.apple.quarantine)를 달고 오면 Apple Silicon 은 「손상되었기 때문에 열 수 없습니다」
// 로 판정하고 여는 선택지를 주지 않는다. electron-builder 가 번들을 다시 조립한 뒤 서명을 다시 걸지 않아서다(`mac.identity: null`).
//
// **신원:** 키체인에 `LITECODE_SIGN_IDENTITY`(기본 "litecode-dev") 코드 서명 인증서가 있으면 그것으로, 없으면 ad-hoc(`-`).
// ad-hoc 은 빌드마다 서명이 바뀌어 macOS 가 문서 폴더 등 개인정보 허락(TCC)을 빌드마다 다시 묻는다 — 허락은 지정 요건
// (identifier + 인증서 leaf 해시)으로 기억되므로 같은 인증서로 서명하면 다시 빌드해도 한 번 허락이 남는다 (2026-10-02, 사용자
// "이게 계속 뜨는데"). "litecode-dev" 는 이 개발 Mac 에 만든 자체 서명 인증서다 — 신뢰되지 않은 인증서라 신원 증명·공증과는 별건이고,
// 다른 Mac 에선 ad-hoc 과 같다. 배포용은 Developer ID + 공증이 따로 필요하다.
//
// 동봉한 opencode·rg(Contents/Resources/…)는 따로 서명하지 않는다 — --deep 은 코드 자리만 내려가고 Resources 는 리소스로 봉인한다.

const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

function signingIdentity() {
  const name = process.env.LITECODE_SIGN_IDENTITY ?? 'litecode-dev'
  if (name === '-') return '-'
  try {
    // -v 를 안 준다 — 자체 서명 인증서는 "신뢰 안 됨" 이라 -v(유효한 것만)에 안 나오지만 codesign 은 쓸 수 있다
    const listed = execFileSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' })
    return listed.includes(`"${name}"`) ? name : '-'
  } catch {
    return '-'
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const identity = signingIdentity()
  execFileSync('codesign', ['--force', '--deep', '--sign', identity, app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--strict', app], { stdio: 'inherit' })
  console.log(`  • 서명 완료 (${identity === '-' ? 'ad-hoc' : identity})  ${app}`)
}
