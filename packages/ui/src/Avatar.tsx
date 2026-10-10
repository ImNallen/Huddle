import { useEffect, useState, type CSSProperties, type FormEvent } from 'react'
import { Upload, UserRound } from 'lucide-react'
import {
  MascotColor,
  MascotShape,
  type Avatar as AvatarValue,
  type Profile,
} from '@huddle/contracts'
import { Alert, Primary, useNow } from './primitives'
import { errorText } from './transport'

export const colors = {
  indigo: '#818cf8',
  sky: '#38bdf8',
  teal: '#2dd4bf',
  lime: '#a3e635',
  amber: '#fbbf24',
  orange: '#fb923c',
  rose: '#fb7185',
  violet: '#c084fc',
}
export function Avatar({
  avatar,
  name,
  photo,
  size = 54,
}: {
  avatar?: AvatarValue | null
  name: string
  photo?: (uploadId: string, signal: AbortSignal) => Promise<string>
  size?: number
}) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    setSrc('')
    if (avatar?.kind !== 'photo' || !photo) return
    const abort = new AbortController()
    void photo(avatar.uploadId, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setSrc(value)
      })
      .catch(() => setSrc(''))
    return () => abort.abort()
  }, [avatar, photo])
  if (avatar?.kind === 'photo' && src)
    return <img className="access-avatar-photo" src={src} alt={name} width={size} height={size} />
  if (!avatar || avatar.kind === 'photo')
    return (
      <span className="avatar" style={{ width: size, height: size }} aria-label={name}>
        {name.slice(0, 2).toUpperCase()}
      </span>
    )
  const style: CSSProperties & { '--mascot-color': string } = {
    '--mascot-color': colors[avatar.color],
    width: size,
    height: size,
  }
  return (
    <span
      className={`access-avatar access-avatar-${avatar.shape}`}
      style={style}
      role="img"
      aria-label={`${avatar.color} ${avatar.shape} mascot`}
    />
  )
}
export function ProfileEditor({
  initial,
  save,
  upload,
  photo,
  busy,
  submitLabel,
}: {
  initial: Profile
  save: (profile: Profile) => Promise<void>
  upload: (file: File) => Promise<string>
  photo: (id: string, signal: AbortSignal) => Promise<string>
  busy: boolean
  submitLabel: string
}) {
  const [profile, setProfile] = useState(initial)
  const [tab, setTab] = useState<'mascot' | 'photo'>(initial.avatar.kind)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [file, setFile] = useState<{ name: string; size?: string } | null>(null)
  const [lastMascot, setLastMascot] = useState<Mascot>(
    initial.avatar.kind === 'mascot' ? initial.avatar : defaultMascot,
  )
  const now = useNow()
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void save(profile)
  }
  async function selectPhoto(selected: File) {
    setUploading(true)
    setError('')
    try {
      if (
        !['image/png', 'image/jpeg', 'image/webp'].includes(selected.type) ||
        selected.size > 5 * 1024 * 1024
      )
        throw new Error('Choose a PNG, JPG or WebP photo smaller than 5 MB.')
      const uploadId = await upload(selected)
      setProfile((current) => ({ ...current, avatar: { kind: 'photo', uploadId } }))
      setFile({ name: selected.name, size: await dimensions(selected) })
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setUploading(false)
    }
  }
  const mascot = profile.avatar.kind === 'mascot' ? profile.avatar : lastMascot
  function pick(next: Mascot) {
    setLastMascot(next)
    setProfile((current) => ({ ...current, avatar: next }))
  }
  const hasPhoto = profile.avatar.kind === 'photo'
  const name = profile.name.trim() || 'Your name'
  return (
    <form onSubmit={submit}>
      <label className="access-label">
        Name
        <input
          required
          maxLength={80}
          value={profile.name}
          onChange={(event) => setProfile((current) => ({ ...current, name: event.target.value }))}
          placeholder="What should we call you?"
          autoComplete="name"
        />
      </label>
      <p className="access-label-row access-profile-label">Avatar</p>
      <div className="access-segmented" role="group" aria-label="Avatar type">
        <button
          type="button"
          aria-pressed={tab === 'mascot'}
          onClick={() => {
            setTab('mascot')
            setProfile((current) => ({ ...current, avatar: mascot }))
          }}
        >
          Mascot
        </button>
        <button type="button" aria-pressed={tab === 'photo'} onClick={() => setTab('photo')}>
          Photo
        </button>
      </div>
      {tab === 'mascot' ? (
        <div className="access-avatar-panel">
          <div className="access-avatar-stage">
            <Avatar avatar={mascot} name={name} size={52} />
          </div>
          <div>
            <p>Shape</p>
            <div className="access-avatar-options">
              {MascotShape.options.map((shape) => (
                <button
                  type="button"
                  key={shape}
                  aria-label={shape}
                  aria-pressed={mascot.shape === shape}
                  onClick={() => pick({ ...mascot, shape })}
                >
                  <Avatar avatar={{ ...mascot, shape }} name={shape} size={19} />
                </button>
              ))}
            </div>
            <p>
              Color · <strong>{capitalize(mascot.color)}</strong>
            </p>
            <div className="access-avatar-options is-colors">
              {MascotColor.options.map((color) => (
                <button
                  type="button"
                  key={color}
                  aria-label={color}
                  aria-pressed={mascot.color === color}
                  onClick={() => pick({ ...mascot, color })}
                >
                  <span className="access-color" style={{ background: colors[color] }} />
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="access-avatar-panel">
          <div className="access-avatar-stage">
            {hasPhoto ? (
              <Avatar avatar={profile.avatar} name={name} photo={photo} size={60} />
            ) : (
              <UserRound size={22} aria-hidden="true" />
            )}
          </div>
          <div>
            {hasPhoto && file && (
              <p>
                <strong>{file.name}</strong>
                {file.size && ` · ${file.size}`}
              </p>
            )}
            <div className="access-photo-actions">
              <label className="access-tool">
                <Upload size={13} />
                {uploading
                  ? 'Uploading…'
                  : hasPhoto
                    ? 'Upload a different photo'
                    : 'Upload a photo'}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={uploading}
                  hidden
                  onChange={(event) => {
                    const selected = event.target.files?.[0]
                    event.target.value = ''
                    if (selected) void selectPhoto(selected)
                  }}
                />
              </label>
              {hasPhoto && (
                <button
                  type="button"
                  className="access-text-button is-inline"
                  onClick={() => {
                    setFile(null)
                    setProfile((current) => ({ ...current, avatar: lastMascot }))
                  }}
                >
                  Remove
                </button>
              )}
            </div>
            <p>PNG, JPG or WebP up to 5 MB. Cropped to a square.</p>
          </div>
        </div>
      )}
      <p className="access-label-row access-profile-label is-muted">Preview</p>
      <div className="access-preview">
        <Avatar avatar={profile.avatar} name={name} photo={photo} size={28} />
        <div>
          <strong>{name}</strong>
          <time>
            {new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </time>
          <p>Hi everyone, glad to be here.</p>
        </div>
      </div>
      <Alert message={error} />
      <Primary
        busy={busy || uploading}
        disabled={!profile.name.trim() || (tab === 'photo' && !hasPhoto)}
      >
        {submitLabel}
      </Primary>
    </form>
  )
}
type Mascot = Extract<AvatarValue, { kind: 'mascot' }>
const defaultMascot: Mascot = { kind: 'mascot', shape: 'square', color: 'indigo' }
function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
async function dimensions(file: File) {
  try {
    const bitmap = await createImageBitmap(file)
    const size = `${bitmap.width} × ${bitmap.height}`
    bitmap.close()
    return size
  } catch {
    return undefined
  }
}
