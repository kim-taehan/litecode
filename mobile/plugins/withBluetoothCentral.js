// Expo config plugin — 블루투스로 데스크탑을 찾아 붙는 데(폰 = 중심, central) 필요한 권한만 (이슈 #211, 설계 01ab 3절).
//
//   API 31+   BLUETOOTH_SCAN (usesPermissionFlags="neverForLocation" — 스캔으로 위치를 추정하지 않는다) · BLUETOOTH_CONNECT  → "근처 기기" 창 하나
//   API ≤ 30  BLUETOOTH · BLUETOOTH_ADMIN · ACCESS_FINE_LOCATION (전부 maxSdkVersion="30" — 31 이상에서는 묻지도 갖지도 않는다)
//   광고(BLUETOOTH_ADVERTISE)는 데스크탑이 한다 — 폰은 필요 없다
//
// react-native-ble-manager 의 플러그인(app.plugin.js)은 쓰지 않는다: BLUETOOTH·BLUETOOTH_ADMIN 에 maxSdkVersion 을 안 달고 COARSE 위치까지 더한다.
// 라이브러리 자체 AndroidManifest 도 위치 권한을 maxSdkVersion 없이 선언한다 — 빌드 때 매니페스트 병합이 그것을 합치므로, 여기 선언에
// tools:node="replace" 를 달아 우리 것(maxSdkVersion=30)이 이기게 한다. COARSE 위치는 app.json 의 blockedPermissions 가 지운다(tools:node="remove").
// prebuild 결과(android/app/src/main/AndroidManifest.xml)에서 확인할 수 있는 것은 우리 선언까지다 — 병합 결과는 APK 를 빌드해 aapt 로 본다.

const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins')

const PERMISSIONS = [
  { 'android:name': 'android.permission.BLUETOOTH_SCAN', 'android:usesPermissionFlags': 'neverForLocation', 'tools:targetApi': 's' },
  { 'android:name': 'android.permission.BLUETOOTH_CONNECT' },
  { 'android:name': 'android.permission.BLUETOOTH', 'android:maxSdkVersion': '30' },
  { 'android:name': 'android.permission.BLUETOOTH_ADMIN', 'android:maxSdkVersion': '30' },
  { 'android:name': 'android.permission.ACCESS_FINE_LOCATION', 'android:maxSdkVersion': '30' },
]

module.exports = function withBluetoothCentral(config) {
  return withAndroidManifest(config, (modConfig) => {
    const manifest = AndroidConfig.Manifest.ensureToolsAvailable(modConfig.modResults)
    const declared = (manifest.manifest['uses-permission'] ??= [])
    for (const permission of PERMISSIONS) {
      const attributes = { ...permission, 'tools:node': 'replace' }
      const existing = declared.find((item) => item.$?.['android:name'] === permission['android:name'])
      if (existing) existing.$ = attributes
      else declared.push({ $: attributes })
    }
    // BLE 가 없는 폰에도 설치는 된다 — 블루투스를 고르면 "쓸 수 없다" 고 안내한다
    const features = (manifest.manifest['uses-feature'] ??= [])
    if (!features.some((item) => item.$?.['android:name'] === 'android.hardware.bluetooth_le')) {
      features.push({ $: { 'android:name': 'android.hardware.bluetooth_le', 'android:required': 'false' } })
    }
    modConfig.modResults = manifest
    return modConfig
  })
}
