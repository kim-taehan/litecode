import { useEffect, useMemo, useRef, useState } from 'react'
import { featureDefault, featureOn, type FeatureId } from '../shared/features.ts'
import type { RemoteDeviceInfo, RemoteStatus } from '../shared/ipc.ts'
import { isLoopbackHost } from '../shared/remote.ts'
import { reason } from './ipcError.ts'
import { qrPath } from './qrCode.ts'
import { updateSettings, useSettings, useT } from './settingsStore.ts'
import { useFocusTrap } from './focusTrap.ts'

// 설정 > 모바일 (이슈 #56) — 폰 앱이 이 PC 에 붙는 문(ctx.remote)의 화면. 기능 `remote` 가 켜졌을 때만 메뉴에 보인다.
// 일반 페이지의 행(이름 + 회색 설명, 오른쪽 컨트롤)과 버튼을 그대로 쓴다: 연결 상태(사내망·이 PC 안 주소, 지문, 마지막 수신 시도) → 기기 연결 → 짝지은 기기.
// 모바일 연결 전체를 켜고 끄는 스위치는 여기 없다 — 설정 > 기능의 카드 하나다 (#124). 그 안의 길(사내망·블루투스)마다의 토글은 여기 있다
// (이슈 #210, 시안 _workspace/mock-ble/Desk.dc.html): 카드 하나에 `사내망 연결`·`블루투스 연결` 줄(상태 한 줄 + 토글 — 기능 lan·bluetooth 와 같은 값),
// 기기 줄에는 지금 연결 방법 배지(Wi-Fi / 블루투스 / 끊김 — 붙어 있으면 그 스트림의 운반).
// [기기 연결] 은 모달이다: QR(사내망 TLS 주소가 있을 때) + 직접 입력(주소·코드·지문 앞 8자) + 남은 시간. 코드를 쓰거나 만료되면 닫힌다.
// "마지막 수신 시도" 는 진단이다 — 회사 Wi-Fi 의 기기 간 통신 차단·방화벽은 조용히 막아 서버가 알 수 없다. 시도가 없으면 그대로 "없음" 을 보인다.
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

/** 기능 하나를 켜거나 끈다 — 설정 > 기능의 카드와 같은 값 (기본값과 같으면 지운다) */
function setFeature(stored: Partial<Record<FeatureId, boolean>>, feature: FeatureId, on: boolean): Promise<unknown> {
  const next = { ...stored }
  if (on === featureDefault(feature)) delete next[feature]
  else next[feature] = on
  return updateSettings({ features: next })
}

export function MobilePage() {
  const t = useT()
  const { language, features = {} } = useSettings()
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
  const lan = status.addresses.filter((address) => !isLoopbackHost(hostOf(address)))
  const local = status.addresses.filter((address) => isLoopbackHost(hostOf(address)))
  const lanOn = featureOn(features, 'lan')
  const bluetoothOn = featureOn(features, 'bluetooth')
  const lanLine = !lanOn
    ? t('remote.lan.off')
    : lan.length > 0
      ? [t('remote.lan.waiting', { addresses: lan.join(', ') }), ...(status.fingerprintCode ? [t('remote.lan.fingerprint', { code: status.fingerprintCode })] : [])].join(' · ')
      : t('remote.status.noLan')
  const bluetooth = status.bluetooth
  const bluetoothLine = !bluetoothOn
    ? t('remote.bluetooth.off')
    : !bluetooth || bluetooth.state === 'starting'
      ? t('remote.bluetooth.starting')
      : bluetooth.state === 'advertising'
        ? bluetooth.devices.length > 0
          ? t('remote.bluetooth.connectedTo', { names: bluetooth.devices.join(', ') })
          : bluetooth.links > 0
            ? t('remote.bluetooth.connected')
            : t('remote.bluetooth.advertising')
        : bluetooth.state === 'unsupported'
          ? bluetooth.reason
            ? t('remote.bluetooth.unsupportedReason', { reason: bluetooth.reason })
            : t('remote.bluetooth.unsupported')
          : bluetooth.state === 'failed'
            ? t('remote.bluetooth.failed', { reason: bluetooth.reason ?? '' })
            : t(`remote.bluetooth.${bluetooth.state}`)
  const toggle = (feature: FeatureId, on: boolean) => run(() => setFeature(features, feature, on))
  const via = (device: RemoteDeviceInfo) => (!device.connected ? 'none' : device.via === 'bluetooth' ? 'bluetooth' : 'wifi')
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
      <div className="mobile-paths">
        <div className="mobile-path" data-path="lan">
          <div className="settings-row__text">
            <div className="settings-row__title">{t('remote.lan')}</div>
            <div className="settings-row__description" data-testid="remote-lan-status">
              {lanLine}
            </div>
            {(local.length > 0 || lan.length > 0) && (
              <dl className="mobile-pairing mobile-page__status">
                {local.length > 0 && (
                  <>
                    <dt>{t('remote.status.local')}</dt>
                    <dd>
                      <code>{local.join(', ')}</code>
                      <span className="mobile-pairing__note">{t('remote.pair.emulator', { port: status.port })}</span>
                    </dd>
                  </>
                )}
                {lan.length > 0 && (
                  <>
                    <dt>{t('remote.status.lastAttempt')}</dt>
                    <dd data-testid="remote-last-attempt">
                      {status.lastAttemptAt ? date(status.lastAttemptAt) : <span className="mobile-pairing__note">{t('remote.status.noAttempt')}</span>}
                    </dd>
                  </>
                )}
              </dl>
            )}
            {status.error && status.error.code !== 'ENOLAN' && (
              <div className="settings-error" role="alert">
                {status.error.code === 'EADDRINUSE' ? t('remote.error.portInUse', { port: status.port }) : t('remote.error.listen', { message: status.error.message })}
              </div>
            )}
          </div>
          <button type="button" role="switch" className="settings-switch" aria-checked={lanOn} aria-label={t('remote.lan')} onClick={() => toggle('lan', !lanOn)}>
            <span className="settings-switch__thumb" />
          </button>
        </div>
        <div className="mobile-path" data-path="bluetooth">
          <div className="settings-row__text">
            <div className="settings-row__title">{t('remote.bluetooth')}</div>
            <div
              className={`settings-row__description${bluetoothOn && bluetooth?.state === 'advertising' ? ' mobile-path__status--ok' : ''}`}
              data-testid="remote-bluetooth-status"
            >
              {bluetoothLine}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            className="settings-switch"
            aria-checked={bluetoothOn}
            aria-label={t('remote.bluetooth')}
            onClick={() => toggle('bluetooth', !bluetoothOn)}
          >
            <span className="settings-switch__thumb" />
          </button>
        </div>
      </div>
      <p className="mobile-pairing__note mobile-paths__note">{t('remote.paths.note')}</p>

      <div className="settings-row">
        <div className="settings-row__text">
          <div className="settings-row__title">{t('remote.pair')}</div>
          <div className="settings-row__description">{t('remote.pair.description')}</div>
        </div>
        <button type="button" className="settings-button" disabled={!listening} onClick={() => run(() => window.litecode.startRemotePairing())}>
          {t('remote.pair')}
        </button>
      </div>
      {pairing && (
        <PairDialog
          pairing={pairing}
          addresses={lan.length > 0 ? lan : local}
          emulatorPort={lan.length > 0 ? undefined : status.port}
          fingerprintCode={status.fingerprintCode}
          bluetooth={bluetoothOn}
          secondsLeft={secondsLeft}
          onCancel={() => run(() => window.litecode.cancelRemotePairing())}
        />
      )}

      <div className="settings-row settings-row--stacked">
        <div className="settings-row__title">{t('remote.devices')}</div>
        {status.devices.length === 0 && <div className="settings-row__description">{t('remote.devices.empty')}</div>}
        {status.devices.map((device) => (
          <div key={device.id} className="mobile-device" data-device={device.id}>
            <div className="settings-row__text">
              <div className="settings-row__title">{device.name}</div>
              <div className="settings-row__description">{detail(device)}</div>
            </div>
            <span className={`mobile-device__via mobile-device__via--${via(device)}`} data-via={via(device)}>
              {t(`remote.via.${via(device)}`)}
            </span>
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

/** `ip:port`·`[ip]:port` 의 호스트 */
function hostOf(address: string): string {
  return address.slice(0, address.lastIndexOf(':'))
}

/** [기기 연결] 모달 — QR(사내망 주소가 있을 때) + 폰 앱의 "주소·코드 직접 입력" 에 넣을 값 + 지문 앞 8자. Esc·[취소] 는 코드를 버린다 */
function PairDialog(props: {
  pairing: NonNullable<RemoteStatus['pairing']>
  addresses: string[]
  /** 사내망 주소가 없을 때만 — 에뮬레이터 안내 */
  emulatorPort?: number
  fingerprintCode?: string
  /** 블루투스 연결이 켜져 있다 — 직접 입력 옆에 "블루투스로만 붙을 폰은 QR 로" 안내 (블루투스 키는 손으로 칠 수 없다) */
  bluetooth: boolean
  secondsLeft: number
  onCancel(): void
}) {
  const t = useT()
  const { pairing, addresses, emulatorPort, fingerprintCode, bluetooth, secondsLeft, onCancel } = props
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef)
  const qr = useMemo(() => (pairing.uri ? qrPath(pairing.uri) : undefined), [pairing.uri])
  return (
    <div className="confirm-mask">
      <div
        className="confirm-dialog mobile-pair-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-pair-dialog-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
        }}
      >
        <h2 id="remote-pair-dialog-title" className="confirm-dialog__title">
          {t('remote.pair')}
        </h2>
        {qr ? (
          <>
            <p className="confirm-dialog__description">{t('remote.pair.scan')}</p>
            <svg className="mobile-pair-dialog__qr" viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label={t('remote.pair.qr')} shapeRendering="crispEdges">
              <rect width={qr.size} height={qr.size} fill="#fff" />
              <path d={qr.d} fill="#000" />
            </svg>
          </>
        ) : (
          <p className="confirm-dialog__description">{t('remote.pair.noQr')}</p>
        )}
        <div className="mobile-pair-dialog__manual">
          {t('remote.pair.manual')}
          {bluetooth && <span className="mobile-pairing__note"> · {t('remote.pair.bluetoothQrOnly')}</span>}
        </div>
        <dl className="mobile-pairing">
          <dt>{t('remote.pair.address')}</dt>
          <dd>
            <code>{addresses.join(', ')}</code>
            {emulatorPort !== undefined && <span className="mobile-pairing__note">{t('remote.pair.emulator', { port: emulatorPort })}</span>}
          </dd>
          <dt>{t('remote.pair.code')}</dt>
          <dd>
            <code className="mobile-pairing__code mobile-pairing__code--short">{pairing.shortCode}</code>
          </dd>
          {fingerprintCode && emulatorPort === undefined && (
            <>
              <dt>{t('remote.status.fingerprint')}</dt>
              <dd>
                <code className="mobile-pairing__code">{fingerprintCode}</code>
                <span className="mobile-pairing__note">{t('remote.pair.fingerprintNote')}</span>
              </dd>
            </>
          )}
        </dl>
        <div className="confirm-dialog__actions">
          <span className="mobile-pairing__note mobile-pair-dialog__remaining">{t('remote.pair.remaining', { seconds: secondsLeft })}</span>
          <button type="button" className="settings-button" onClick={onCancel}>
            {t('remote.pair.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 짝짓기 요청의 [허용]/[거절] 확인 — 폰이 코드를 넣으면 뜬다(기기 이름·플랫폼·확인 코드). 코드가 새도 PC 앞의 사람이 눌러야 끝난다.
 *  기본 동작(Esc·바깥 누르기)은 없다 — 허용도 거절도 버튼으로만 한다. 60초 안에 답하지 않으면 요청이 사라진다 */
export function RemotePairPrompt({ on }: { on: boolean }) {
  const t = useT()
  const request = useRemoteStatus(on)?.requests[0]
  // Tab 은 가두되 포커스를 빼앗지는 않는다 — 폰이 띄우는 창이라, 치던 Enter 가 [허용] 에 떨어지면 안 된다
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, { on: !!request, steal: false })
  if (!request) return null
  const answer = (allow: boolean) => void window.litecode.answerRemotePair(request.id, allow).catch(() => {})
  return (
    <div className="confirm-mask">
      <div className="confirm-dialog" ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby="remote-pair-title" aria-describedby="remote-pair-description">
        <h2 id="remote-pair-title" className="confirm-dialog__title">
          {t('remote.request.title')}
        </h2>
        <p id="remote-pair-description" className="confirm-dialog__description">
          {t('remote.request.description')}
        </p>
        <p className="confirm-dialog__description">
          <strong>{t('remote.request.onlyYours')}</strong>
        </p>
        <dl className="mobile-pairing">
          <dt>{PLATFORM[request.platform]}</dt>
          <dd>{request.deviceName}</dd>
          <dt>{request.pinned ? t('remote.status.fingerprint') : t('remote.request.confirm')}</dt>
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
