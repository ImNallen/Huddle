import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Modal } from '../Dialogs'
import { Alert } from '../primitives'
import { SCHEMES, type Scheme } from './palette'
import { MAX_FILE_BYTES, parseThemeFile, TOO_LARGE } from './themeFile'
import { ThemeSearch } from './ThemeSearch'
import { appearance, type Undo } from './store'

export function AddThemeDialog({
  onClose,
  onSaved,
  onInstalled,
}: {
  onClose: () => void
  onSaved: (id: string, sides: readonly Scheme[]) => void
  onInstalled: (message: string, undo: Undo | null) => void
}) {
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState<string>()
  const [saveError, setSaveError] = useState('')
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const parsed = text.trim() ? parseThemeFile(text, fileName) : null

  async function readFile(file: File) {
    if (file.size > MAX_FILE_BYTES) return setSaveError(TOO_LARGE)
    setFileName(file.name)
    setSaveError('')
    setText(await file.text())
  }
  // A file dropped anywhere the dialog does not catch would navigate the whole app to that file.
  useEffect(() => {
    const over = (event: DragEvent) => {
      event.preventDefault()
      setDragging(true)
    }
    const leave = (event: DragEvent) => {
      if (!event.relatedTarget) setDragging(false)
    }
    const drop = (event: DragEvent) => {
      event.preventDefault()
      setDragging(false)
      const file = event.dataTransfer?.files[0]
      if (file) void readFile(file)
    }
    document.addEventListener('dragover', over)
    document.addEventListener('dragleave', leave)
    document.addEventListener('drop', drop)
    return () => {
      document.removeEventListener('dragover', over)
      document.removeEventListener('dragleave', leave)
      document.removeEventListener('drop', drop)
    }
  }, [])
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!parsed?.ok) return
    const result = appearance.save(parsed.theme)
    if (!result.ok) return setSaveError(result.error)
    onSaved(
      result.id,
      SCHEMES.filter((scheme) => parsed.theme[scheme]),
    )
    onClose()
  }
  return (
    <Modal
      className="is-wide"
      title="Add a theme"
      description="Bring a theme from T3 Code or VS Code. It stays on this device."
      onClose={onClose}
    >
      <ThemeSearch
        onInstalled={(message, undo) => {
          onInstalled(message, undo)
          onClose()
        }}
      />
      <p className="add-theme-divider">Or import a file</p>
      <form className={dragging ? 'add-theme is-dragging' : 'add-theme'} onSubmit={submit}>
        <div className="add-theme-file">
          <span>
            Theme file
            <small>Drop a .json or .jsonc file here</small>
          </span>
          <button type="button" className="button small" onClick={() => picker.current?.click()}>
            Choose file
          </button>
          <input
            ref={picker}
            type="file"
            className="sr-only"
            aria-label="Theme file"
            tabIndex={-1}
            accept=".json,.jsonc,application/json"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void readFile(file)
              event.target.value = ''
            }}
          />
        </div>
        <label className="field">
          Theme JSON
          <textarea
            spellCheck={false}
            placeholder="Paste theme JSON here…"
            rows={3}
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              setSaveError('')
            }}
          />
        </label>
        {parsed?.ok && <p className="add-theme-note">{parsed.notes.join(' ')}</p>}
        <Alert message={saveError || (parsed && !parsed.ok ? parsed.error : '')} />
        <div className="modal-actions">
          <button type="button" className="button text" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={!parsed?.ok}>
            Add theme
          </button>
        </div>
      </form>
    </Modal>
  )
}
