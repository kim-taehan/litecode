// Expo config plugin — 평문 http 를 **이 컴퓨터 안(루프백) 주소로만** 허용한다 (이슈 #62).
// 데스크탑은 아직 127.0.0.1 에 평문으로만 연다(에뮬레이터에서는 10.0.2.2). 그 밖의 주소로는 OS 가 평문 연결 자체를 막는다 —
// 앱 코드(src/app/address.ts isLoopbackHost)가 먼저 거르고, 이것이 한 번 더 막는다. 호스트 목록은 address.ts LOOPBACK_HOSTS 와 같아야 한다.
// 사내망(LAN)은 TLS·지문 고정 라운드에서 연다 — 그때 이 목록을 넓히지 말고 TLS 로 간다.
//
// prebuild 가 하는 일: res/xml/network_security_config.xml 을 쓰고, AndroidManifest 의 <application> 에
// android:networkSecurityConfig 를 건다(android:usesCleartextTraffic 은 지운다 — 설정 파일이 정본이다).

const fs = require('node:fs')
const path = require('node:path')
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins')

const LOOPBACK_HOSTS = ['10.0.2.2', '127.0.0.1', 'localhost']

const XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- 생성된 파일 (plugins/withLoopbackCleartext.js) — 평문 http 는 이 컴퓨터 안 주소로만 -->
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
${LOOPBACK_HOSTS.map((host) => `        <domain includeSubdomains="false">${host}</domain>`).join('\n')}
    </domain-config>
</network-security-config>
`

module.exports = function withLoopbackCleartext(config) {
  config = withDangerousMod(config, [
    'android',
    (modConfig) => {
      const dir = path.join(modConfig.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'network_security_config.xml'), XML)
      return modConfig
    },
  ])
  return withAndroidManifest(config, (modConfig) => {
    const application = modConfig.modResults.manifest.application[0]
    application.$['android:networkSecurityConfig'] = '@xml/network_security_config'
    delete application.$['android:usesCleartextTraffic']
    return modConfig
  })
}
