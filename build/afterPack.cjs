// mac 산출물에 ad-hoc 코드 서명을 건다 (closed-code/desktop build/afterPack.cjs 를 옮겼다).
//
// 서명이 깨진 앱이 브라우저 다운로드 꼬리표(com.apple.quarantine)를 달고 오면 Apple Silicon 은 「손상되었기 때문에 열 수 없습니다」
// 로 판정하고 여는 선택지를 주지 않는다. electron-builder 가 번들을 다시 조립한 뒤 서명을 다시 걸지 않아서다(`mac.identity: null`).
// ad-hoc 서명은 신원을 증명하지 않는다 — 판정을 「확인되지 않은 개발자」로 바꿀 뿐이고, 공증은 별건이다.
//
// 동봉한 opencode·rg(Contents/Resources/…)는 따로 서명하지 않는다 — --deep 은 코드 자리만 내려가고 Resources 는 리소스로 봉인한다.
// 로컬 실행은 된다. 브라우저·USB 로 받은 zip 에서도 뜨는지는 아직 안 쟀다.

const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--strict', app], { stdio: 'inherit' })
  console.log(`  • ad-hoc 서명 완료  ${app}`)
}
