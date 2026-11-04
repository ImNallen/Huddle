import { getCurrentWindow } from '@tauri-apps/api/window'
import { Minus, Square, X } from 'lucide-react'

const controls = [
  { label: 'Minimize', icon: <Minus size={14} />, act: () => getCurrentWindow().minimize() },
  { label: 'Maximize', icon: <Square size={12} />, act: () => getCurrentWindow().toggleMaximize() },
  { label: 'Close window', icon: <X size={15} />, act: () => getCurrentWindow().close() },
]

export function WindowBar({ title }: { title: string }) {
  // macOS draws its own traffic lights over this bar through the Overlay title bar style.
  const drawsControls = !navigator.userAgent.includes('Macintosh')
  return (
    <div className="window-bar" data-tauri-drag-region>
      <span data-tauri-drag-region>{title}</span>
      {drawsControls && (
        <div className="window-controls">
          {controls.map(({ label, icon, act }) => (
            <button
              key={label}
              type="button"
              aria-label={label}
              title={label}
              onClick={() => void act()}
            >
              {icon}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
