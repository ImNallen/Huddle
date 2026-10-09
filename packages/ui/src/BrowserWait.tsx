import { Monitor, ExternalLink } from 'lucide-react'
import { Frame, Heading, Alert } from './primitives'
export function BrowserWait({
  server,
  code,
  expiresAt,
  error,
  open,
  cancel,
}: {
  server: { name: string; origin: string }
  code: string
  expiresAt: number
  error: string
  open: () => void
  cancel: () => void
}) {
  return (
    <Frame server={server}>
      <Heading
        title="Sign in in your browser"
        icon={<Monitor size={20} />}
        description="Huddle opens your company's sign-in page in your default browser. Match the code below, then approve this desktop."
        back={cancel}
      />
      <button className="access-primary" onClick={open}>
        <ExternalLink size={15} />
        Open browser to sign in
      </button>
      <div className="access-card">
        <p>Match this code in your browser</p>
        <div className="access-wait-code">{code}</div>
        <p role="status">
          Waiting for your approval. Expires at{' '}
          {new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
        </p>
      </div>
      <Alert message={error} />
      <button className="access-link" onClick={cancel}>
        Cancel sign-in
      </button>
    </Frame>
  )
}
