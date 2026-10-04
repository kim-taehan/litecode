// 폰에 직접 설치할 APK 를 만든다 (이슈 #47) — `npm run apk` (mobile/ 에서).
//
// release variant 다: JS 번들(Hermes 바이트코드)이 APK 안 `assets/index.android.bundle` 에 들어가 Metro 없이 단독으로 켜진다.
// 서명은 **디버그 키**(prebuild 가 만든 android/app/debug.keystore — expo 템플릿이 release 에도 이 키를 쓴다). 스토어 배포용이 아니라
// 내 폰에 직접 깔아 보는 용도다. ABI 는 arm64-v8a 하나(요즘 폰 전부) — 32비트 기기·x86 에뮬레이터에는 안 깔린다.
//
// 필요한 것: JDK(없으면 Android Studio 에 든 것을 쓴다), Android SDK(ANDROID_HOME, 없으면 ~/Library/Android/sdk), PATH 의 node.
// Gradle 이 SDK 구성 요소(platform·build-tools·NDK)가 없으면 ANDROID_HOME 에 내려받는다.
// 결과: <레포>/release/litecode-mobile.apk (인자로 다른 경로를 줄 수 있다: `npm run apk -- /절대/경로.apk`)

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.resolve(process.argv[2] ?? path.join(mobile, '..', 'release', 'litecode-mobile.apk'))

const studioJdk = '/Applications/Android Studio.app/Contents/jbr/Contents/Home'
const env = {
  ...process.env,
  JAVA_HOME: process.env.JAVA_HOME ?? (existsSync(studioJdk) ? studioJdk : undefined),
  ANDROID_HOME: process.env.ANDROID_HOME ?? path.join(os.homedir(), 'Library', 'Android', 'sdk'),
  NODE_ENV: 'production',
}

function run(command, args, cwd) {
  console.log(`\n$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// app.json → android/ (네이티브 프로젝트는 커밋하지 않는다 — 매번 여기서 맞춘다)
run('npx', ['expo', 'prebuild', '--platform', 'android', '--no-install'], mobile)
// 데몬을 남기지 않는다 (--no-daemon, Kotlin 컴파일도 같은 프로세스에서). Kotlin 을 같은 프로세스에서 돌리면 템플릿 기본 메모리로는
// "Not enough memory to run compilation" 으로 실패한다(실측) → 힙·메타스페이스를 올린다
run(
  './gradlew',
  ['assembleRelease', '-PreactNativeArchitectures=arm64-v8a', '--no-daemon', '-Pkotlin.compiler.execution.strategy=in-process', '-Dorg.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g'],
  path.join(mobile, 'android'),
)

const built = path.join(mobile, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
mkdirSync(path.dirname(output), { recursive: true })
copyFileSync(built, output)
console.log(`\nAPK: ${output} (${(statSync(output).size / 1024 / 1024).toFixed(1)} MB)`)
