import { EmojiText } from './Emoji'
import type { CSSProperties } from 'react'
import { Hash, Volume2 } from 'lucide-react'
import type { ChannelKind } from '@huddle/contracts'

const hues = [330, 85, 190, 285, 25, 220, 160, 255]
export function initials(name: string) {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? []
  const [first = '', second] = words
  if (second) return (first.charAt(0) + second.charAt(0)).toUpperCase()
  if (first.length <= 3) return first.toUpperCase()
  const consonant = first.slice(1).match(/[b-df-hj-np-tv-z]/i)?.[0] ?? first.charAt(1)
  return (first.charAt(0) + consonant).toUpperCase()
}
function hue(id: string) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hues[hash % hues.length]
}
export function Badge({ id, name, size = 22 }: { id: string; name: string; size?: number }) {
  const style: CSSProperties & { '--hue'?: number; '--size': string } = {
    '--hue': hue(id),
    '--size': `${size}px`,
  }
  return (
    <span className="badge" style={style} aria-hidden="true">
      {initials(name)}
    </span>
  )
}
export function ChannelIcon({ kind, size }: { kind: ChannelKind; size: number }) {
  const Icon = kind === 'voice' ? Volume2 : Hash
  return <Icon size={size} strokeWidth={1.6} />
}
export function Mentions({ text }: { text: string }) {
  return text.split(/(@[\p{L}\p{N}_-]+)/u).map((part, index) =>
    index % 2 ? (
      <span className="mention" key={index}>
        {part}
      </span>
    ) : (
      <EmojiText key={index} text={part} />
    ),
  )
}
export function sentence(text: string) {
  return `${text.replace(/\.+$/, '')}.`
}
export function clock(createdAt: string) {
  return new Date(createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
