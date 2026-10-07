// 앱 시작 지점(index.ts 첫 줄)에서 불러온다 — 다른 무엇보다 먼저 globalThis.crypto.getRandomValues 를 채운다 (randomValues.ts)
import { getRandomValues } from 'expo-crypto'
import { installRandomValues } from './randomValues.ts'

installRandomValues(getRandomValues)
