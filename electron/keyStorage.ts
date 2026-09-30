// API 키를 safeStorage 로 저장해도 되는가. electron 을 import 하지 않는 순수 판정이라 단위 테스트로 돈다.
// 키링(libsecret·kwallet)이 없는 Linux 에서 Electron 은 고정 비밀번호로 암호화하는 basic_text 백엔드를 쓰면서도
// isEncryptionAvailable() 에 true 를 준다 — 사실상 난독화라 쓸 수 없는 것으로 친다 (03_qa 경고, 리더 결정).
// getSelectedStorageBackend() 는 Linux 전용이라 다른 OS 에서는 backend 를 안 넘긴다.
export function canSealKeys(platform: NodeJS.Platform, available: boolean, backend?: string): boolean {
  return available && !(platform === 'linux' && backend === 'basic_text')
}
