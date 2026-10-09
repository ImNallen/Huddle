import { createFileRoute } from '@tanstack/react-router'
export const Route = createFileRoute('/')({ component: Home })
function Home() {
  return (
    <main className="card">
      <div className="brand">
        huddle<span>●</span>
      </div>
      <p className="eyebrow">YOUR TEAM. YOUR SERVER.</p>
      <h1>A place to work together.</h1>
      <p>
        This Huddle server is ready for your desktop app. Connect the app to this server's address
        to create a workspace or join your team.
      </p>
      <a className="button" href="/login">
        Sign in to your account
      </a>
      <a href="/device">Authorize a desktop</a>
      <footer>
        <a href="/api/health">Server health</a>
      </footer>
    </main>
  )
}
