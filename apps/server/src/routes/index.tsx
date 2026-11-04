import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { CopyButton, Frame, Heading, ServerCard } from '@huddle/ui'
import { version } from '../../package.json'
import { serverName, setupRequired } from '../lib/admission'
import { config } from '../lib/config'

const landing = createServerFn({ method: 'GET' }).handler(async () => ({
  name: await serverName(),
  setupRequired: await setupRequired(),
  origin: config.SERVER_URL,
  version,
}))
export const Route = createFileRoute('/')({ loader: () => landing(), component: Home })

function Home() {
  const { name, setupRequired, origin, version } = Route.useLoaderData()
  return (
    <Frame
      actions={<a href="/login">Sign in</a>}
      footer={
        <>
          <span className="landing-status">
            <a href="/api/health">
              <i className="landing-dot" />
              Server health
            </a>
            <code>huddle {version}</code>
          </span>
          {!setupRequired && <span>Run by {name}</span>}
        </>
      }
    >
      <ServerCard
        server={setupRequired ? { origin } : { name, origin }}
        label={setupRequired ? 'New server' : undefined}
      >
        <CopyButton value={origin} label="Copy server address" iconOnly />
      </ServerCard>
      <Heading
        title="A place for your friends."
        description={
          setupRequired
            ? "This Huddle server isn't set up yet. If you're the admin, select Set up this server and enter the setup code from the server log."
            : `This is the Huddle server for ${name.endsWith('.') ? name : `${name}.`} Sign in here on the host. Friends connect by pasting the invite from Huddle.`
        }
      />
      <a className="access-primary" href="/login">
        {setupRequired ? 'Set up this server' : 'Sign in to your account'}
      </a>
      {!setupRequired && <p className="access-footer">New here? Ask the host for an invite.</p>}
    </Frame>
  )
}
