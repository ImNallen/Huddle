import { Moon, Pencil, Sun, Trash2 } from 'lucide-react'
import { CopyButton } from '../primitives'
import { PaletteScope } from './PaletteScope'
import { SCHEMES, type Scheme } from './palette'
import { appearance, type ListedTheme, type Selected } from './store'

const halfOf = (theme: ListedTheme, scheme: Scheme) =>
  theme.kind === 'huddle' ? undefined : theme[scheme]
const hasSide = (theme: ListedTheme, scheme: Scheme) =>
  theme.kind === 'huddle' || Boolean(theme[scheme])

export function ThemeCard({
  theme,
  selected,
  onPick,
  onEdit,
  onDelete,
}: {
  theme: ListedTheme
  selected: Selected
  onPick: (scheme: Scheme) => void
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <li className="theme-card">
      <div className="theme-swatches">
        {SCHEMES.filter((scheme) => hasSide(theme, scheme)).map((scheme) => {
          const label = `${theme.name} ${scheme}`
          return (
            <label key={scheme} className="theme-swatch" title={label}>
              <PaletteScope scheme={scheme} half={halfOf(theme, scheme)} className="theme-orb">
                <input
                  type="radio"
                  name={`theme-${scheme}`}
                  aria-label={label}
                  checked={selected[scheme] === theme.id}
                  onChange={() => {
                    appearance.select(scheme, theme.id)
                    onPick(scheme)
                  }}
                />
              </PaletteScope>
              <i className="theme-swatch-badge" aria-hidden="true">
                {scheme === 'light' ? <Sun size={10} /> : <Moon size={10} />}
              </i>
            </label>
          )
        })}
      </div>
      <div className="theme-card-footer">
        <span title={theme.name}>{theme.name}</span>
        {theme.kind === 'custom' && (
          <button
            type="button"
            className="icon-button"
            aria-label={`Edit ${theme.name}`}
            title={`Edit ${theme.name}`}
            onClick={onEdit}
          >
            <Pencil size={14} />
          </button>
        )}
        <CopyButton
          iconOnly
          label={`Copy ${theme.name} as JSON`}
          value={() => appearance.fileText(theme.id)}
        />
        {theme.kind === 'custom' && (
          <button
            type="button"
            className="icon-button"
            aria-label={`Delete ${theme.name}`}
            title={`Delete ${theme.name}`}
            onClick={onDelete}
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>
    </li>
  )
}
