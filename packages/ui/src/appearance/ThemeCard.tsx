import { Check, Pencil, Trash2 } from 'lucide-react'
import { CopyButton } from '../primitives'
import { PaletteScope } from './PaletteScope'
import { SCHEMES, type Scheme } from './palette'
import { appearance, type ListedTheme, type Selected } from './store'

import huddleLight from '../assets/themes/huddle-light.svg'
import huddleDark from '../assets/themes/huddle-dark.svg'
import indigoLight from '../assets/themes/indigo-light.svg'
import indigoDark from '../assets/themes/indigo-dark.svg'
import mossLight from '../assets/themes/moss-light.svg'
import mossDark from '../assets/themes/moss-dark.svg'
import harborLight from '../assets/themes/harbor-light.svg'
import harborDark from '../assets/themes/harbor-dark.svg'
import clayLight from '../assets/themes/clay-light.svg'
import clayDark from '../assets/themes/clay-dark.svg'
import plumLight from '../assets/themes/plum-light.svg'
import plumDark from '../assets/themes/plum-dark.svg'

const builtInOrbs: Readonly<Record<string, { light: string; dark: string }>> = {
  huddle: { light: huddleLight, dark: huddleDark },
  indigo: { light: indigoLight, dark: indigoDark },
  moss: { light: mossLight, dark: mossDark },
  harbor: { light: harborLight, dark: harborDark },
  clay: { light: clayLight, dark: clayDark },
  plum: { light: plumLight, dark: plumDark },
}

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
          const orb = theme.kind === 'custom' ? undefined : builtInOrbs[theme.id]?.[scheme]
          return (
            <label key={scheme} className="theme-swatch" title={label}>
              <PaletteScope scheme={scheme} half={halfOf(theme, scheme)} className="theme-orb">
                <input
                  type="radio"
                  style={orb ? { backgroundImage: `url("${orb}")` } : undefined}
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
                <Check size={10} strokeWidth={1.5} />
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
