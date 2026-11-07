import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

export function Popover({
  id,
  label,
  role = 'group',
  children,
  className = '',
  side = 'bottom',
  align = 'end',
  menu = false,
  closeOnAction = menu,
  popoverRef,
  anchorRef,
  gap = 8,
  onOpen,
  onClose,
}: {
  id: string
  label: string
  role?: 'group' | 'region'
  children: ReactNode
  className?: string
  side?: 'bottom' | 'top' | 'left'
  align?: 'start' | 'end'
  menu?: boolean
  closeOnAction?: boolean
  popoverRef?: RefObject<HTMLDivElement | null>
  anchorRef?: RefObject<HTMLElement | null>
  gap?: number
  onOpen?: () => void
  onClose?: () => void
}) {
  const localRef = useRef<HTMLDivElement>(null)
  const ref = popoverRef ?? localRef
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const panel = ref.current
    const trigger = [...document.querySelectorAll<HTMLButtonElement>('[popovertarget]')].find(
      (button) => button.getAttribute('popovertarget') === id,
    )
    if (!panel || !trigger) return
    function place() {
      if (!panel || !trigger) return
      if (!trigger.isConnected || !trigger.getClientRects().length) {
        panel.hidePopover()
        return
      }
      const box = (anchorRef?.current ?? trigger).getBoundingClientRect()
      const width = panel.offsetWidth
      const height = panel.offsetHeight
      let left = align === 'start' ? box.left : box.right - width
      let top = side === 'top' ? box.top - height - gap : box.bottom + gap
      if (side === 'left') {
        left = box.left - width - gap
        top = box.top
      }
      if (side === 'bottom' && top + height > window.innerHeight - 16) top = box.top - height - gap
      if (side === 'top' && top < 16) top = box.bottom + gap
      panel.style.left = `${Math.max(16, Math.min(left, window.innerWidth - width - 16))}px`
      panel.style.top = `${Math.max(16, Math.min(top, window.innerHeight - height - 16))}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(panel)
    observer.observe(trigger)
    if (anchorRef?.current) observer.observe(anchorRef.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, id, side, align, ref, anchorRef, gap])
  return (
    <div
      ref={ref}
      id={id}
      popover="auto"
      role={role}
      aria-label={label}
      className={`anchored-popover ${menu ? 'menu' : ''} ${className}`}
      onToggle={(event) => {
        const shown = event.newState === 'open'
        setOpen(shown)
        if (shown) {
          onOpen?.()
          if (menu)
            event.currentTarget.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
        } else onClose?.()
      }}
      onClickCapture={(event) => {
        if (!closeOnAction || !(event.target instanceof Element)) return
        const button = event.target.closest('button')
        if (button && !button.disabled && !button.hasAttribute('data-keep-open'))
          event.currentTarget.hidePopover()
      }}
      onKeyDown={(event) => {
        if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
        ]
        const index = buttons.findIndex((button) => button === document.activeElement)
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }}
      onBlur={(event) => {
        if (
          menu &&
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          event.currentTarget.hidePopover()
      }}
    >
      {children}
    </div>
  )
}
