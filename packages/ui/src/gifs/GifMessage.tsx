import { useState } from 'react'
import { Play } from 'lucide-react'
import type { GifRef } from '@huddle/contracts'

const MAX_WIDTH = 400
const MAX_HEIGHT = 300
const MIN_SIDE = 40

export function gifBox(size: { width: number; height: number }) {
  const scale = Math.min(1, MAX_WIDTH / size.width, MAX_HEIGHT / size.height)
  return {
    width: Math.max(MIN_SIDE, Math.round(size.width * scale)),
    height: Math.max(MIN_SIDE, Math.round(size.height * scale)),
  }
}

export const gifName = ({ title }: Pick<GifRef, 'title'>) => (title ? `${title}, GIF` : 'GIF')

export function GifMessage({ gif }: { gif: GifRef }) {
  const [playing, setPlaying] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const box = gifBox(gif)
  const size = { width: box.width, aspectRatio: `${box.width} / ${box.height}` }
  if (unavailable)
    return (
      <div
        className="gif-message gif-unavailable"
        style={size}
        role="img"
        aria-label={`${gifName(gif)} unavailable`}
      >
        <span aria-hidden="true">GIF unavailable</span>
      </div>
    )
  return (
    <div
      className="gif-message"
      style={size}
      role="img"
      aria-label={gifName(gif)}
      tabIndex={0}
      data-playing={playing || undefined}
      onPointerEnter={() => setPlaying(true)}
      onPointerLeave={() => setPlaying(false)}
      onFocus={() => setPlaying(true)}
      onBlur={() => setPlaying(false)}
    >
      <picture>
        {!playing && <source media="(prefers-reduced-motion: reduce)" srcSet={gif.still} />}
        <img
          src={gif.animated}
          alt=""
          width={box.width}
          height={box.height}
          referrerPolicy="no-referrer"
          decoding="async"
          onError={() => setUnavailable(true)}
        />
      </picture>
      <span className="gif-tag" aria-hidden="true">
        GIF
      </span>
      <span className="gif-play" aria-hidden="true">
        <Play size={14} fill="currentColor" strokeWidth={0} />
      </span>
    </div>
  )
}
