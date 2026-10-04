// Metro 설정 — 앱은 레포 루트의 shared/(계약 타입·i18n 등 순수 TS)를 그대로 가져다 쓴다 (사용자 결정 2026-10-02).
// 프로젝트 폴더(mobile/) 밖이라 watchFolders 에 넣어야 Metro 가 읽는다. 의존성은 mobile/node_modules 것만 쓴다(루트와 합치지 않는다).
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
config.watchFolders = [path.resolve(__dirname, '../shared')]
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')]

module.exports = config
