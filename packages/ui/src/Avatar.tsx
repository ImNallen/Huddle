import { useEffect, useState, type CSSProperties, type FormEvent } from 'react'
import { Shuffle, Upload } from 'lucide-react'
import {
  MascotColor,
  MascotShape,
  type Avatar as AvatarValue,
  type Profile,
} from '@huddle/contracts'
import { Alert, Primary } from './primitives'
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
}: {
  initial: Profile
  save: (profile: Profile) => Promise<void>
  upload: (file: File) => Promise<string>
  photo: (id: string, signal: AbortSignal) => Promise<string>
  busy: boolean
}) {
  const [profile, setProfile] = useState(initial)
  const [tab, setTab] = useState<'mascot' | 'photo'>(initial.avatar.kind)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void save(profile)
  }
  async function selectPhoto(file: File) {
    setUploading(true)
    setError('')
    try {
      if (
        !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
        file.size > 5 * 1024 * 1024
      )
        throw new Error('Choose a PNG, JPEG or WebP photo smaller than 5 MB.')
      const uploadId = await upload(file)
      setProfile((current) => ({ ...current, avatar: { kind: 'photo', uploadId } }))
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setUploading(false)
    }
  }
  const mascot =
    profile.avatar.kind === 'mascot'
      ? profile.avatar
      : ({ kind: 'mascot', shape: 'circle', color: 'indigo' } satisfies AvatarValue)
  function randomize() {
    const shape =
      MascotShape.options[Math.floor(Math.random() * MascotShape.options.length)] ?? 'circle'
    const color =
      MascotColor.options[Math.floor(Math.random() * MascotColor.options.length)] ?? 'indigo'
    setProfile((current) => ({ ...current, avatar: { kind: 'mascot', shape, color } }))
  }
  return (
    <form onSubmit={submit}>
      <label className="access-label">
        Display name
        <input
          required
          maxLength={80}
          value={profile.name}
          onChange={(event) => setProfile((current) => ({ ...current, name: event.target.value }))}
          placeholder="What should we call you?"
          autoComplete="name"
        />
      </label>
      <label className="access-label">Avatar</label>
      <div className="access-actions">
        <button
          type="button"
          className="access-link"
          aria-pressed={tab === 'mascot'}
          onClick={() => {
            setTab('mascot')
            setProfile((current) => ({ ...current, avatar: mascot }))
          }}
        >
          Mascot
        </button>
        <button
          type="button"
          className="access-link"
          aria-pressed={tab === 'photo'}
          onClick={() => setTab('photo')}
        >
          Photo
        </button>
      </div>
      <div className="access-card">
        {tab === 'mascot' ? (
          <div className="access-avatar-picker">
            <Avatar avatar={mascot} name={profile.name} size={80} />
            <div>
              <p>Shape</p>
              <div className="access-avatar-options">
                {MascotShape.options.map((shape) => (
                  <button
                    type="button"
                    key={shape}
                    aria-label={shape}
                    aria-pressed={mascot.shape === shape}
                    onClick={() =>
                      setProfile((current) => ({ ...current, avatar: { ...mascot, shape } }))
                    }
                  >
                    <Avatar avatar={{ ...mascot, shape }} name={shape} size={24} />
                  </button>
                ))}
              </div>
              <p>Color · {mascot.color}</p>
              <div className="access-avatar-options">
                {MascotColor.options.map((color) => (
                  <button
                    type="button"
                    key={color}
                    aria-label={color}
                    aria-pressed={mascot.color === color}
                    onClick={() =>
                      setProfile((current) => ({ ...current, avatar: { ...mascot, color } }))
                    }
                  >
                    <span className="access-color" style={{ background: colors[color] }} />
                  </button>
                ))}
              </div>
              <button type="button" className="access-link" onClick={randomize}>
                <Shuffle size={12} /> Surprise me
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="access-avatar-preview">
              <Avatar avatar={profile.avatar} name={profile.name} photo={photo} size={80} />
              <label className="access-link">
                <Upload size={14} /> {uploading ? 'Uploading…' : 'Choose photo'}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={uploading}
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void selectPhoto(file)
                  }}
                />
              </label>
            </div>
            <p>PNG, JPEG or WebP. Up to 5 MB and 4096 × 4096 pixels.</p>
          </>
        )}
      </div>
      <label className="access-label">Preview</label>
      <div className="access-card access-avatar-preview">
        <Avatar
          avatar={profile.avatar}
          name={profile.name || 'Your name'}
          photo={photo}
          size={32}
        />
        <div>
          <strong>{profile.name || 'Your name'}</strong>
          <p>Hi everyone, glad to be here.</p>
        </div>
      </div>
      <Alert message={error} />
      <Primary
        busy={busy || uploading}
        disabled={!profile.name.trim() || (tab === 'photo' && profile.avatar.kind !== 'photo')}
      >
        Continue
      </Primary>
    </form>
  )
}
