import Svg, { Circle, Path, Rect } from 'react-native-svg'
import { C } from './theme.ts'

// 아이콘 — 시안의 SVG 경로 그대로.

const line = { fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export function ChevronRight({ size = 16, color = C.sub }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" stroke={color} strokeWidth={1.5} {...line}>
      <Path d="M6 3l5 5-5 5" />
    </Svg>
  )
}

export function ChevronDown({ size = 16, color = C.sub }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" stroke={color} strokeWidth={1.5} {...line}>
      <Path d="M4 6l4 4 4-4" />
    </Svg>
  )
}

export function BackArrow() {
  return (
    <Svg width={20} height={20} viewBox="0 0 20 20" stroke={C.text} strokeWidth={1.75} {...line}>
      <Path d="M12.5 4l-6 6 6 6" />
    </Svg>
  )
}

export function Gear() {
  return (
    <Svg width={20} height={20} viewBox="0 0 20 20" stroke={C.text2} strokeWidth={1.5} {...line}>
      <Circle cx={10} cy={10} r={2.75} />
      <Path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
    </Svg>
  )
}

export function QrFrame() {
  return (
    <Svg width={56} height={56} viewBox="0 0 56 56" stroke={C.sub} strokeWidth={2.5} {...line}>
      <Path d="M6 18V10a4 4 0 0 1 4-4h8M38 6h8a4 4 0 0 1 4 4v8M50 38v8a4 4 0 0 1-4 4h-8M18 50h-8a4 4 0 0 1-4-4v-8" />
      <Rect x={18} y={18} width={8} height={8} />
      <Rect x={30} y={18} width={8} height={8} />
      <Rect x={18} y={30} width={8} height={8} />
      <Path d="M30 30h8v8" />
    </Svg>
  )
}

export function Warning() {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" stroke={C.amberText} strokeWidth={1.5} {...line}>
      <Path d="M8 2l6 11H2z" />
      <Path d="M8 6.5v3M8 11.5v.2" />
    </Svg>
  )
}

export function ArrowUp() {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" stroke={C.white} strokeWidth={1.75} {...line}>
      <Path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
    </Svg>
  )
}

/** Wi-Fi (시안 mock-ble Main) */
export function WifiIcon({ size = 24, color = C.sub }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={1.8} {...line}>
      <Path d="M2.5 9a14 14 0 0 1 19 0" />
      <Path d="M5.5 12.5a9.5 9.5 0 0 1 13 0" />
      <Path d="M8.7 16a5 5 0 0 1 6.6 0" />
      <Circle cx={12} cy={19.3} r={0.9} />
    </Svg>
  )
}

/** 블루투스 (시안 mock-ble Main·Bt·Fail) */
export function BluetoothIcon({ size = 24, color = C.sub, strokeWidth = 1.8 }: { size?: number; color?: string; strokeWidth?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth} {...line}>
      <Path d="M7 7.5l10 9-5 4.5V3l5 4.5-10 9" />
    </Svg>
  )
}

/** 동그라미 느낌표 (시안 mock-ble Fail) */
export function ErrorCircle({ color }: { color: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" stroke={color} strokeWidth={1.5} {...line}>
      <Circle cx={8} cy={8} r={6.2} />
      <Path d="M8 4.6v4" />
      <Path d="M8 11v.1" />
    </Svg>
  )
}
