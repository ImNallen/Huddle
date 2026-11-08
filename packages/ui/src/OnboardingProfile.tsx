import { useEffect, useRef, useState } from 'react'
import type { AccessStage } from '@huddle/contracts'
import type { Connection } from './connection'
import { Frame, Heading, Alert } from './primitives'
import { ProfileEditor } from './Avatar'
import { errorText } from './transport'

export function OnboardingProfile({
  client,
  stage,
  serverName,
  onDone,
  onAccessChanged,
}: {
  client: Connection
  stage: Extract<AccessStage, { kind: 'ready' }>
  serverName: string
  onDone: (stage: Extract<AccessStage, { kind: 'ready' }>) => void
  onAccessChanged: (stage: AccessStage) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  return (
    <Frame className="onboarding-profile">
      <Heading
        title="Make it yours."
        description={`Choose how you appear in ${serverName}. You can change this later in Settings.`}
      />
      <ProfileEditor
        initial={{ name: stage.user.name, avatar: stage.user.avatar }}
        busy={busy}
        submitLabel="Save and continue"
        context={{ kind: 'onboarding', onSkip: () => onDone(stage) }}
        photo={(id, signal) => client.photo(id, signal)}
        upload={(file) => client.upload(file)}
        save={async (profile) => {
          setBusy(true)
          setError('')
          try {
            const next = await client.act({ kind: 'profile.save', profile })
            if (!active.current || !client.active) return
            if (next.kind === 'ready' && next.user.id === stage.user.id) onDone(next)
            else onAccessChanged(next)
          } catch (error) {
            if (active.current) setError(errorText(error))
          } finally {
            if (active.current) setBusy(false)
          }
        }}
      />
      <Alert message={error} />
    </Frame>
  )
}
