/** Electron 이 IPC 오류 앞에 붙이는 "Error invoking remote method '…': Error: " 를 떼고 사유만 */
export function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
