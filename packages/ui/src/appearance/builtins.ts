import { color, type ColorLiteral } from './color'
import type { Half, TokenName } from './palette'

export type HalfSet = { light: Half; dark?: Half } | { light?: Half; dark: Half }
export type Theme = { id: string; name: string } & HalfSet

const half = (
  background: string,
  accent: string,
  overrides: Partial<Record<TokenName, string>> = {},
): Half => ({
  background: color(background),
  accent: color(accent),
  overrides: Object.fromEntries(
    Object.entries(overrides).map(([name, value]): [string, ColorLiteral] => [name, color(value)]),
  ),
})

export const HUDDLE_ID = 'huddle'
export const HUDDLE_NAME = 'Huddle'

const seeded = (
  name: string,
  dark: readonly [string, string],
  light: readonly [string, string],
): Theme => ({
  id: name.toLowerCase(),
  name,
  light: half(...light),
  dark: half(...dark),
})

// Indigo keeps the palette Huddle shipped before its T3 colors, so upgrading does not delete a look.
// Only the values under a guard floor moved, and by the smallest step that clears it.
const INDIGO: Theme = {
  id: 'indigo',
  name: 'Indigo',
  light: half('#ffffff', '#5865f2', {
    chrome: '#e3e5e8',
    sidebar: '#f2f3f5',
    panel: '#ebedef',
    'rail-tile': '#ffffff',
    raised: '#ffffff',
    card: '#ffffff',
    input: '#ebedef',
    secondary: '#e3e5e8',
    'secondary-hover': '#d7d9dc',
    tile: '#dfe1e5',
    hover: 'rgb(6 6 7 / 0.05)',
    selected: 'rgb(6 6 7 / 0.09)',
    'message-hover': 'rgb(6 6 7 / 0.03)',
    line: 'rgb(6 6 7 / 0.09)',
    'line-strong': 'rgb(6 6 7 / 0.16)',
    text: '#1f2125',
    strong: '#060607',
    muted: '#5c5e66',
    faint: '#5c5e66',
    placeholder: '#5c5e66',
    'accent-hover': '#4752c4',
    focus: '#5865f2',
    link: '#4752c4',
    'on-accent': '#ffffff',
    'mention-bg': 'rgb(88 101 242 / 0.15)',
    mention: '#3c45a5',
    green: '#036c36',
    amber: '#83520c',
    danger: '#b5222a',
    'danger-fill': '#da373c',
    'access-field-from': '#262a8c',
    'access-field-to': '#2a54c8',
    'access-card': '#ffffff',
    'access-input': '#ebedef',
    'scroll-thumb': 'rgb(6 6 7 / 0.22)',
  }),
  dark: half('#1b1a1f', '#5865f2', {
    chrome: '#131215',
    sidebar: '#131215',
    panel: '#212025',
    'rail-tile': '#212025',
    raised: '#242328',
    card: '#1c1b20',
    input: '#212327',
    secondary: '#2a292e',
    'secondary-hover': '#38373d',
    tile: '#393a40',
    hover: 'rgb(255 255 255 / 0.05)',
    selected: 'rgb(255 255 255 / 0.11)',
    'message-hover': 'rgb(255 255 255 / 0.04)',
    line: 'rgb(255 255 255 / 0.07)',
    'line-strong': 'rgb(255 255 255 / 0.13)',
    text: '#f2f2f3',
    strong: '#ffffff',
    muted: '#a5a4a9',
    faint: '#a4a3a8',
    placeholder: '#a0a2a7',
    'accent-hover': '#4752c4',
    focus: '#8a93f6',
    link: '#afbeed',
    'on-accent': '#ffffff',
    'mention-bg': 'rgb(88 101 242 / 0.3)',
    mention: '#c9cdfb',
    green: '#3eb86c',
    amber: '#f0b232',
    danger: '#fa7c7b',
    'danger-fill': '#da373c',
    'access-field-from': '#1a1650',
    'access-field-to': '#2b52d2',
    'access-card': '#323339',
    'access-input': '#27292d',
    'scroll-thumb': 'rgb(255 255 255 / 0.16)',
  }),
}

export const BUILT_IN_THEMES: readonly Theme[] = [
  INDIGO,
  seeded('Moss', ['#0f1410', '#4caf7d'], ['#f6f8f5', '#2f7d54']),
  seeded('Harbor', ['#0c1218', '#3a9bdc'], ['#f4f7fa', '#1d6fa8']),
  seeded('Clay', ['#14100d', '#e07a45'], ['#faf6f2', '#b4541f']),
  seeded('Plum', ['#120f17', '#a06ee8'], ['#f8f6fb', '#7343c4']),
]
