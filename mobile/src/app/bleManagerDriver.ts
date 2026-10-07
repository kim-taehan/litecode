// 라디오 — react-native-ble-manager(12.x, 새 아키텍처)를 BleDriver 모양으로 감싼다 (이슈 #211). 폰이 중심(central), 데스크탑이 주변기기다.
// 이 파일은 Node 시험에서 돌지 않는다(네이티브 모듈) — 흐름(스캔 → 연결 → MTU → 구독 → 조각 쓰기)은 core/bluetoothLink.ts 에 있고 가짜 드라이버로 시험한다.
// 실기기 확인은 사용자가 한다: 권한 창·스캔·연결·MTU·끊김 (보고서의 체크리스트).
//
// - 권한·어댑터 확인(prepare)은 블루투스를 고른 뒤 붙을 때만 부른다 — Wi-Fi 를 쓰는 동안에는 BleManager.start 도 부르지 않는다.
// - 블루투스가 꺼져 있으면 켜 달라는 시스템 창을 띄우지 않는다(재연결 중에 저절로 뜨면 안 된다) — 사유(bluetooth-off)를 보이고 사람이 켠다.

import { PermissionsAndroid, Platform, type EventSubscription } from 'react-native'
import BleManager, { BleScanMode, BleState, ConnectionPriority } from 'react-native-ble-manager'
import { BluetoothError, type BleDriver } from '../core/index.ts'

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

export function createBleManagerDriver(apiLevel: number | undefined): BleDriver {
  let started: Promise<void> | undefined
  /** 기기 id → 그 기기의 알림 구독들 (끊을 때 거둔다) */
  const subscriptions = new Map<string, EventSubscription[]>()
  const drop = (deviceId: string): void => {
    for (const subscription of subscriptions.get(deviceId) ?? []) subscription.remove()
    subscriptions.delete(deviceId)
  }

  return {
    async prepare() {
      if (Platform.OS === 'android') {
        // API 31+: "근처 기기"(스캔·연결) 하나의 창. API 30 이하: 위치 권한이 있어야 스캔 결과가 온다
        const wanted =
          (apiLevel ?? 31) >= 31
            ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
            : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]
        const answers = await PermissionsAndroid.requestMultiple(wanted)
        if (!wanted.every((permission) => answers[permission] === PermissionsAndroid.RESULTS.GRANTED)) throw new BluetoothError('permission', 'nearby devices permission denied')
      }
      started ??= BleManager.start({ showAlert: false }).catch((error: unknown) => {
        started = undefined
        throw new BluetoothError('unsupported', `ble start failed: ${String(error)}`)
      })
      await started
      const state = await BleManager.checkState()
      if (state === BleState.Unsupported) throw new BluetoothError('unsupported', 'no BLE on this phone')
      if (state === BleState.Unauthorized) throw new BluetoothError('permission', 'bluetooth unauthorized')
      if (state !== BleState.On) throw new BluetoothError('bluetooth-off', `bluetooth is ${state}`)
    },

    scan(serviceUuid, timeoutMs) {
      return new Promise((resolve) => {
        let done = false
        const finish = (deviceId: string | undefined): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          found.remove()
          stopped.remove()
          if (deviceId !== undefined) void BleManager.stopScan().catch(() => undefined)
          resolve(deviceId)
        }
        // 서비스 UUID 로 걸러 스캔한다 — 걸린 것은 우리 데스크탑이다(UUID 가 desktopId 에서 나온다). 광고에 UUID 가 실려 있는지 한 번 더 본다
        const found = BleManager.onDiscoverPeripheral((peripheral) => {
          const uuids = peripheral.advertising?.serviceUUIDs
          if (!uuids || uuids.some((uuid) => same(uuid, serviceUuid))) finish(peripheral.id)
        })
        const stopped = BleManager.onStopScan(() => finish(undefined))
        const timer = setTimeout(() => {
          void BleManager.stopScan().catch(() => undefined)
          finish(undefined)
        }, timeoutMs + 1_000)
        BleManager.scan({ serviceUUIDs: [serviceUuid], seconds: Math.ceil(timeoutMs / 1_000), allowDuplicates: false, scanMode: BleScanMode.LowLatency }).catch(() => finish(undefined))
      })
    },

    async connect(deviceId, serviceUuid) {
      await BleManager.connect(deviceId)
      await BleManager.retrieveServices(deviceId, [serviceUuid])
    },

    requestMtu: (deviceId, mtu) => BleManager.requestMTU(deviceId, mtu),

    async requestHighPriority(deviceId) {
      await BleManager.requestConnectionPriority(deviceId, ConnectionPriority.high)
    },

    async subscribe(deviceId, serviceUuid, characteristicUuid, onValue) {
      const subscription = BleManager.onDidUpdateValueForCharacteristic((event) => {
        if (event.peripheral === deviceId && same(event.characteristic, characteristicUuid)) onValue(Uint8Array.from(event.value))
      })
      subscriptions.set(deviceId, [...(subscriptions.get(deviceId) ?? []), subscription])
      await BleManager.startNotification(deviceId, serviceUuid, characteristicUuid)
    },

    // 조각은 이미 MTU−3 이하다 — maxByteSize 를 조각 길이로 줘서 모듈이 다시 자르지 않게 한다
    write: (deviceId, serviceUuid, characteristicUuid, bytes) => BleManager.writeWithoutResponse(deviceId, serviceUuid, characteristicUuid, Array.from(bytes), Math.max(1, bytes.length)),

    onDisconnect(deviceId, listener) {
      const subscription = BleManager.onDisconnectPeripheral((event) => {
        if (event.peripheral !== deviceId) return
        drop(deviceId)
        listener()
      })
      return () => subscription.remove()
    },

    async disconnect(deviceId) {
      drop(deviceId)
      await BleManager.disconnect(deviceId)
    },
  }
}
