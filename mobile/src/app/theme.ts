// 색·글자 — 시안(_workspace/mock-mobile)의 inline style 값 그대로 (데스크탑 renderer/styles.css 토큰과 같은 값). 밝은 테마만.
// 글꼴은 시스템 글꼴(Android 기본 한글), 고정폭은 monospace.

export const C = {
  text: '#0f1115',
  text2: '#2b2e33',
  sub: '#61666b',
  faint: '#adb2b8',
  white: '#ffffff',
  surface: '#f9fafb',
  surface2: '#f5f6f7',
  border: 'rgba(0,0,0,0.1)',
  borderStrong: 'rgba(0,0,0,0.16)',
  hair: 'rgba(0,0,0,0.06)',
  blue: '#4176e6',
  link: '#2f5fc4',
  blueDark: '#1f4391',
  blueBg: '#e4edfd',
  blueBorder: '#b9cdf6',
  amber: '#c77700',
  amberBg: '#fef5e7',
  amberBorder: '#f7ad31',
  amberText: '#6b4300',
  green: '#2c7a4b',
  red: '#b3261e',
  // 안 될 때 상자 (시안 mock-ble Fail)
  redBg: '#fdf0ee',
  redBorder: '#e3b4af',
  redTitle: '#8f1f19',
  redText: '#5a1a16',
} as const

export const MONO = 'monospace'
