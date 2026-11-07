import { useEffect, useRef } from 'react'

export function Tooltips() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const panel = ref.current
    if (!panel) return
    let source: HTMLElement | null = null
    let pending: ReturnType<typeof setTimeout> | undefined
    function hide() {
      clearTimeout(pending)
      if (source) {
        const descriptions =
          source
            .getAttribute('aria-describedby')
            ?.split(/\s+/)
            .filter((id) => id !== 'huddle-tooltip') ?? []
        if (descriptions.length) source.setAttribute('aria-describedby', descriptions.join(' '))
        else source.removeAttribute('aria-describedby')
      }
      source = null
      panel?.hidePopover()
    }
    function show(target: HTMLElement, immediate: boolean) {
      if (source === target) return
      hide()
      source = target
      const display = () => {
        if (!panel || !target.isConnected || !target.getClientRects().length) return
        panel.textContent = target.dataset.tooltip ?? ''
        panel.showPopover()
        const box = target.getBoundingClientRect()
        const left = box.left + box.width / 2 - panel.offsetWidth / 2
        const top = box.top - panel.offsetHeight - 8
        panel.style.left = `${Math.max(8, Math.min(left, innerWidth - panel.offsetWidth - 8))}px`
        panel.style.top = `${top < 8 ? box.bottom + 8 : top}px`
        target.setAttribute(
          'aria-describedby',
          [target.getAttribute('aria-describedby'), 'huddle-tooltip'].filter(Boolean).join(' '),
        )
      }
      if (immediate) display()
      else pending = setTimeout(display, 300)
    }
    function over(event: PointerEvent) {
      if (event.pointerType === 'touch') return
      const target =
        event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tooltip]') : null
      if (target) show(target, false)
    }
    function out(event: PointerEvent) {
      const from = event.target instanceof Element ? event.target : null
      if (!from || (from.closest('[data-tooltip]') !== source && !panel?.contains(from))) return
      if (
        event.relatedTarget instanceof Node &&
        (source?.contains(event.relatedTarget) || panel?.contains(event.relatedTarget))
      )
        return
      hide()
    }
    function focus(event: FocusEvent) {
      if (
        event.target instanceof HTMLElement &&
        event.target.matches('[data-tooltip]:focus-visible')
      )
        show(event.target, true)
    }
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') hide()
    }
    document.addEventListener('pointerover', over)
    document.addEventListener('pointerout', out)
    document.addEventListener('focusin', focus)
    document.addEventListener('focusout', hide)
    document.addEventListener('pointerdown', hide)
    document.addEventListener('keydown', key)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      hide()
      document.removeEventListener('pointerover', over)
      document.removeEventListener('pointerout', out)
      document.removeEventListener('focusin', focus)
      document.removeEventListener('focusout', hide)
      document.removeEventListener('pointerdown', hide)
      document.removeEventListener('keydown', key)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [])
  return (
    <div ref={ref} id="huddle-tooltip" className="action-tooltip" role="tooltip" popover="manual" />
  )
}
