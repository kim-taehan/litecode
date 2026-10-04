import { useEffect, useState } from 'react'
import type { RemoteDeviceInfo, RemoteStatus } from '../shared/ipc.ts'
import { reason } from './Settings.tsx'
import { useSettings, useT } from './settingsStore.ts'

// 설정 > 모바일 (이슈 #56) — 폰 앱이 이 PC 에 붙는 문(ctx.remote)의 화면. 기능 `remote` 가 켜졌을 때만 메뉴에 보인다.
// 일반 페이지의 행(이름 + 회색 설명, 오른쪽 컨트롤)과 스위치·버튼을 그대로 쓴다: 연결 켜기 → 기기 연결(주소·코드·남은 시간) → 짝지은 기기.
// QR 그림은 아직 없다(다음 라운드 — 라이브러리와 함께). 지금은 폰 앱의 "주소·코드 직접 입력" 에 넣을 값만 보인다.
// 짝짓기 요청의 [허용]/[거절] 확인은 설정을 닫아도 뜨도록 앱 바탕에 건다 (RemotePairPrompt — App.tsx).

/** 메인이 쥔 모바일 연결 상태 — 처음 한 번 읽고 그 뒤는 메인이 밀어 준다. on 이 false 면(기능 꺼짐) 묻지 않는다 */
export function useRemoteStatus(on: boolean): RemoteStatus | undefined {
  const [status, setStatus] = useState<RemoteStatus>()
  useEffect(() => {
    if (!on) return setStatus(undefined)
    let alive = true
    const apply = (next: RemoteStatus) => void (alive && setStatus(next))
    const off = window.litecode.onRemoteChanged(apply)
    void window.litecode.remoteStatus().then(apply, () => {})
    return () => {
      alive = false
      off()
    }
  }, [on])
  return status
}

/** until(ms) 까지 남은 초 — 1초마다 다시 센다. 지났으면 0 */
function useSecondsLeft(until: number | undefined): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (until === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [until])
  return until === undefined ? 0 : Math.max(0, Math.ceil((until - now) / 1000))
}

const PLATFORM = { android: 'Android', ios: 'iOS' } as const

export function MobilePage() {
  const t = useT()
  const { language } = useSettings()
  const status = useRemoteStatus(true)
  const [error, setError] = useState<string>()
  const [confirmingRevoke, setConfirmingRevoke] = useState<string>()
  const secondsLeft = useSecondsLeft(status?.pairing?.expiresAt)
  if (!status) return null

  const run = (action: () => Promise<unknown>): void =>
    void action().then(
      () => setError(undefined),
      (failure: unknown) => setError(reason(failure)),
    )
  const listening = status.addresses.length > 0
  const pairing = secondsLeft > 0 ? status.pairing : undefined
  const date = (at: number) => new Date(at).toLocaleString(language)
  const detail = (device: RemoteDeviceInfo) =>
    [
      PLATFORM[device.platform],
      t('remote.device.paired', { date: date(device.pairedAt) }),
      device.connected ? t('remote.device.connected') : device.lastSeenAt ? t('remote.device.lastSeen', { date: date(device.lastSeenAt) }) : t('remote.device.never'),
    ].join(' · ')

  return (
    <div className="general-page mobile-page">
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      <div className="settings-row">
        <div className="settings-row__text">
          <div className="settings-row__title">{t('remote.enable')}</div>
          <div className="settings-row__description">{t('remote.enable.description')}</div>
          {listening && <div className="settings-row__description mobile-page__address">{t('remote.listening', { addresses: status.addresses.join(', ') })}</div>}
          {status.error && (
            <div className="settings-error" role="alert">
              {status.error.code === 'EADDRINUSE' ? t('remote.error.portInUse', { port: status.port }) : t('remote.error.listen', { message: status.error.message })}
            </div>
          )}
        </div>
        <button
          type="button"
          role="switch"
          className="settings-switch"
          aria-checked={status.enabled}
          aria-label={t('remote.enable')}
          onClick={() => run(() => window.litecode.setRemoteEnabled(!status.enabled))}
        >
          <span className="settings-switch__thumb" />
        </button>
      </div>

      <div className="settings-row">
        <div className="settings-row__text">
          <div className="settings-row__title">{t('remote.pair')}</div>
          <div className="settings-row__description">{t('remote.pair.description')}</div>
          {pairing && (
            <dl className="mobile-pairing">
              <dt>{t('remote.pair.address')}</dt>
              <dd>
                <code>{status.addresses[0]}</code>
                <span className="mobile-pairing__note">{t('remote.pair.emulator', { port: status.port })}</span>
              </dd>
              <dt>{t('remote.pair.code')}</dt>
              <dd>
                <code className="mobile-pairing__code">{pairing.code}</code>
                <span className="mobile-pairing__note">{t('remote.pair.remaining', { seconds: secondsLeft })}</span>
              </dd>
            </dl>
          )}
        </div>
        {pairing ? (
          <button type="button" className="settings-button" onClick={() => run(() => window.litecode.cancelRemotePairing())}>
            {t('remote.pair.cancel')}
          </button>
        ) : (
          <button type="button" className="settings-button" disabled={!listening} onClick={() => run(() => window.litecode.startRemotePairing())}>
            {t('remote.pair')}
          </button>
        )}
      </div>

      <div className="settings-row settings-row--stacked">
        <div className="settings-row__title">{t('remote.devices')}</div>
        {status.devices.length === 0 && <div className="settings-row__description">{t('remote.devices.empty')}</div>}
        {status.devices.map((device) => (
          <div key={device.id} className="mobile-device" data-device={device.id}>
            <div className="settings-row__text">
              <div className="settings-row__title">{device.name}</div>
              <div className="settings-row__description">{detail(device)}</div>
            </div>
            {confirmingRevoke === device.id ? (
              <>
                <button
                  type="button"
                  className="settings-button settings-button--danger"
                  onClick={() => {
                    setConfirmingRevoke(undefined)
                    run(() => window.litecode.revokeRemoteDevice(device.id))
                  }}
                >
                  {t('remote.device.confirmRevoke')}
                </button>
                <button type="button" className="settings-button" onClick={() => setConfirmingRevoke(undefined)}>
                  {t('remote.pair.cancel')}
                </button>
              </>
            ) : (
              <button type="button" className="settings-button" onClick={() => setConfirmingRevoke(device.id)}>
                {t('remote.device.revoke')}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/** 짝짓기 요청의 [허용]/[거절] 확인 — 폰이 코드를 넣으면 뜬다(기기 이름·플랫폼·확인 코드). 코드가 새도 PC 앞의 사람이 눌러야 끝난다.
 *  기본 동작(Esc·바깥 누르기)은 없다 — 허용도 거절도 버튼으로만 한다. 60초 안에 답하지 않으면 요청이 사라진다 */
export function RemotePairPrompt({ on }: { on: boolean }) {
  const t = useT()
  const request = useRemoteStatus(on)?.requests[0]
  if (!request) return null
  const answer = (allow: boolean) => void window.litecode.answerRemotePair(request.id, allow).catch(() => {})
  return (
    <div className="confirm-mask">
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="remote-pair-title" aria-describedby="remote-pair-description">
        <h2 id="remote-pair-title" className="confirm-dialog__title">
          {t('remote.request.title')}
        </h2>
        <p id="remote-pair-description" className="confirm-dialog__description">
          {t('remote.request.description')}
        </p>
        <dl className="mobile-pairing">
          <dt>{PLATFORM[request.platform]}</dt>
          <dd>{request.deviceName}</dd>
          <dt>{t('remote.request.confirm')}</dt>
          <dd>
            <code className="mobile-pairing__code">{request.confirm}</code>
          </dd>
        </dl>
        <div className="confirm-dialog__actions">
          <button type="button" className="attention-card__button attention-card__button--reject" onClick={() => answer(false)}>
            {t('remote.request.deny')}
          </button>
          <button type="button" className="attention-card__button attention-card__button--primary" onClick={() => answer(true)}>
            {t('remote.request.allow')}
          </button>
        </div>
      </div>
    </div>
  )
}
