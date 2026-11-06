import type { CSSProperties, ReactNode } from 'react'
import { resolveHalf, type Half, type Palette, type Scheme, type TokenName } from './palette'

const PREVIEW_TOKENS: readonly TokenName[] = [
  'chrome',
  'sidebar',
  'bg',
  'panel',
  'input',
  'line',
  'line-strong',
  'secondary',
  'muted',
  'accent',
]
const resolved = new WeakMap<Half, Palette>()

function tokensOf(half: Half, scheme: Scheme): CSSProperties {
  const palette = resolved.get(half) ?? resolveHalf(half, scheme)
  resolved.set(half, palette)
  return Object.fromEntries(PREVIEW_TOKENS.map((name) => [`--${name}`, palette[name]]))
}

/** Gives its children one half's colors, whatever the app is showing. A custom sheet targets only
 *  `:root`, so `[data-palette]` still reads Huddle from `chat.css` under any active theme. */
export function PaletteScope({
  scheme,
  half,
  className,
  children,
}: {
  scheme: Scheme
  half: Half | undefined
  className?: string
  children: ReactNode
}) {
  return half ? (
    <span className={className} style={{ colorScheme: scheme, ...tokensOf(half, scheme) }}>
      {children}
    </span>
  ) : (
    <span className={className} data-palette="huddle" style={{ colorScheme: scheme }}>
      {children}
    </span>
  )
}
