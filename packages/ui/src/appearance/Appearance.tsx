import { useState } from 'react'
import { Paintbrush, Plus } from 'lucide-react'
import { Modal } from '../Dialogs'
import { AddThemeDialog } from './AddThemeDialog'
import { PaletteScope } from './PaletteScope'
import { ThemeCard } from './ThemeCard'
import { ThemePanel } from './ThemePanel'
import type { Theme } from './builtins'
import type { Scheme } from './palette'
import { appearance, useAppearance, type ListedTheme, type Mode } from './store'

const MODES: readonly { mode: Mode; label: string }[] = [
  { mode: 'system', label: 'System' },
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
]

function FloorPlan() {
  return (
    <span className="plan">
      <i className="plan-rail">
        <i />
        <i />
        <i />
      </i>
      <i className="plan-side">
        <i />
        <i />
        <i />
        <i />
      </i>
      <i className="plan-chat">
        <i />
        <i />
        <i />
        <i className="plan-composer">
          <i />
        </i>
      </i>
    </span>
  )
}

type Dialog =
  | { kind: 'create' }
  | { kind: 'add' }
  | { kind: 'edit'; theme: Theme }
  | { kind: 'delete'; theme: ListedTheme }
  | null
type Pick = { id: string; sides: readonly Scheme[] }
type Notice = { message: string; undo: (() => void) | null }

function offScreenStatus(
  pick: Pick | null,
  themes: readonly ListedTheme[],
  mode: Mode,
  scheme: Scheme,
) {
  const hidden: Scheme = scheme === 'dark' ? 'light' : 'dark'
  const theme = themes.find((item) => item.id === pick?.id)
  if (!theme || !pick?.sides.includes(hidden)) return ''
  return mode === 'system'
    ? `${theme.name} shows when your system is ${hidden}.`
    : `${theme.name} shows when the color scheme is ${hidden === 'dark' ? 'Dark' : 'Light'}.`
}

export function AppearanceTab() {
  const { mode, scheme, selected, themes } = useAppearance()
  const [dialog, setDialog] = useState<Dialog>(null)
  const [pick, setPick] = useState<Pick | null>(null)
  // Undo restores the moment before the install, so anything else the person does retires it.
  const [notice, setNotice] = useState<Notice | null>(null)
  const close = () => setDialog(null)
  const openDialog = (next: Dialog) => {
    setNotice(null)
    setDialog(next)
  }
  const pickThis = (next: Pick) => {
    setNotice(null)
    setPick(next)
  }
  const selectedHalf = (side: Scheme) => {
    const theme = themes.find((item) => item.id === selected[side])
    return theme?.kind === 'huddle' ? undefined : theme?.[side]
  }
  return (
    <div className="appearance">
      <section>
        <h2 id="appearance-scheme" className="appearance-heading">
          Color scheme
        </h2>
        <fieldset className="scheme-cards" role="radiogroup" aria-labelledby="appearance-scheme">
          {MODES.map((option) => (
            <label key={option.mode} className="scheme-card">
              <input
                type="radio"
                name="scheme"
                checked={mode === option.mode}
                onChange={() => {
                  setNotice(null)
                  appearance.setMode(option.mode)
                }}
              />
              <span className="scheme-preview" aria-hidden="true">
                {option.mode !== 'dark' && (
                  <PaletteScope
                    scheme="light"
                    half={selectedHalf('light')}
                    className={option.mode === 'system' ? 'scheme-pane is-left' : 'scheme-pane'}
                  >
                    <FloorPlan />
                  </PaletteScope>
                )}
                {option.mode !== 'light' && (
                  <PaletteScope
                    scheme="dark"
                    half={selectedHalf('dark')}
                    className={option.mode === 'system' ? 'scheme-pane is-right' : 'scheme-pane'}
                  >
                    <FloorPlan />
                  </PaletteScope>
                )}
              </span>
              <span className="scheme-label">{option.label}</span>
            </label>
          ))}
        </fieldset>
      </section>
      <section>
        <header className="appearance-header">
          <h2 className="appearance-heading">Themes</h2>
          <button
            type="button"
            className="button small"
            onClick={() => openDialog({ kind: 'create' })}
          >
            <Paintbrush size={14} />
            Create theme
          </button>
          <button
            type="button"
            className="button small"
            onClick={() => openDialog({ kind: 'add' })}
          >
            <Plus size={14} />
            Add theme
          </button>
        </header>
        <ul className="theme-grid">
          {themes.map((theme) => (
            <ThemeCard
              key={theme.id}
              theme={theme}
              selected={selected}
              onPick={(side) => pickThis({ id: theme.id, sides: [side] })}
              onEdit={() => {
                if (theme.kind === 'custom') openDialog({ kind: 'edit', theme })
              }}
              onDelete={() => openDialog({ kind: 'delete', theme })}
            />
          ))}
        </ul>
        <p className="appearance-status" role="status">
          {notice?.message ?? offScreenStatus(pick, themes, mode, scheme)}
          {notice?.undo && (
            <>
              {' '}
              <button
                type="button"
                className="link"
                onClick={() => {
                  notice.undo?.()
                  setNotice(null)
                }}
              >
                Undo
              </button>
            </>
          )}
        </p>
      </section>
      {dialog?.kind === 'create' && (
        <ThemePanel
          initialScheme={scheme}
          onClose={close}
          onSaved={(id, side) => pickThis({ id, sides: [side] })}
        />
      )}
      {dialog?.kind === 'edit' && (
        <ThemePanel
          initialScheme={scheme}
          editing={dialog.theme}
          onClose={close}
          onSaved={(id, side) => pickThis({ id, sides: [side] })}
        />
      )}
      {dialog?.kind === 'add' && (
        <AddThemeDialog
          onClose={close}
          onSaved={(id, sides) => pickThis({ id, sides })}
          onInstalled={(message, undo) => {
            setPick(null)
            setNotice({ message, undo })
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <Modal
          title={`Delete ${dialog.theme.name}?`}
          description="It leaves this device. If it's in use, Huddle takes its place."
          onClose={close}
        >
          <div className="modal-actions">
            <button type="button" className="button text" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="button danger"
              onClick={() => {
                appearance.remove(dialog.theme.id)
                close()
              }}
            >
              Delete theme
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
