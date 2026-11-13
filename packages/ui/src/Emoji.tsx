import { emojiCatalog } from '@huddle/contracts'
import type { ReactNode } from 'react'
import { emojiAssets } from './emojiAssets'
export const emojiCode = (symbol: string) =>
  [...symbol]
    .filter((c) => c !== '\ufe0f')
    .map((c) => c.codePointAt(0)?.toString(16))
    .join('-')
export function Emoji({ symbol }: { symbol: string }) {
  const src = emojiAssets[emojiCode(symbol)]
  return src ? (
    <span>
      <img className="color-emoji" src={src} alt={symbol} aria-hidden="true" draggable={false} />
      <span className="sr-only">{symbol}</span>
    </span>
  ) : (
    <>{symbol}</>
  )
}
const supported = new Set(emojiCatalog.map(([symbol]) => symbol))
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
export function EmojiText({ text }: { text: string }) {
  const parts: ReactNode[] = []
  let plain = ''
  for (const { segment, index } of graphemes.segment(text)) {
    if (supported.has(segment)) {
      if (plain) parts.push(plain)
      plain = ''
      parts.push(<Emoji key={index} symbol={segment} />)
    } else plain += segment
  }
  if (plain) parts.push(plain)
  return parts
}
