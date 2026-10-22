import type { MessageKey } from '../shared/i18n/index.ts'
import { useT } from './settingsStore.ts'

// 설정 > 단축키 — 앱의 전역 단축키를 목록으로 보여준다.

const mac = navigator.platform.startsWith('Mac')
const MOD = mac ? '⌘' : 'Ctrl+'

type ShortcutItem = { key: MessageKey; shortcuts: string[] }
type ShortcutGroup = { label: MessageKey; items: ShortcutItem[] }

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    label: 'settings.shortcuts.group.navigation',
    items: [
      { key: 'settings.shortcuts.prevSession', shortcuts: [`${MOD}↑`] },
      { key: 'settings.shortcuts.nextSession', shortcuts: [`${MOD}↓`] },
      { key: 'settings.shortcuts.prevProject', shortcuts: [`${MOD}[`] },
      { key: 'settings.shortcuts.nextProject', shortcuts: [`${MOD}]`] },
      { key: 'settings.shortcuts.projectSwitcher', shortcuts: [`${MOD}K`] },
    ],
  },
  {
    label: 'settings.shortcuts.group.chat',
    items: [
      { key: 'settings.shortcuts.newChat', shortcuts: [`${MOD}N`] },
      { key: 'settings.shortcuts.openSettings', shortcuts: [`${MOD},`] },
    ],
  },
  {
    label: 'settings.shortcuts.group.editor',
    items: [
      { key: 'settings.shortcuts.fileSearch', shortcuts: [`${MOD}P`] },
      { key: 'settings.shortcuts.togglePanel', shortcuts: [`${MOD}B`] },
    ],
  },
]

export function ShortcutsPage() {
  const t = useT()
  return (
    <div className="shortcuts-page">
      <h2 className="shortcuts-page__title">{t('settings.shortcuts.title')}</h2>
      <p className="shortcuts-page__hint">{t('settings.shortcuts.hint')}</p>
      {SHORTCUT_GROUPS.map((group) => (
        <section key={group.label} className="shortcuts-group">
          <h3 className="shortcuts-group__label">{t(group.label)}</h3>
          <ul className="shortcuts-group__list">
            {group.items.map((item) => (
              <li key={item.key} className="shortcut-row">
                <span className="shortcut-row__label">{t(item.key)}</span>
                <span className="shortcut-row__keys">
                  {item.shortcuts.map((s) => (
                    <kbd key={s} className="shortcut-row__kbd">{s}</kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
