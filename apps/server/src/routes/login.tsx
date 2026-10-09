import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { ServerInfo } from '@huddle/contracts'
import { authRequest } from '../lib/browser-auth'
export const Route = createFileRoute('/login')({ component: Login })
function Login() {
  const [signup, setSignup] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [oidc, setOidc] = useState(false)
  useEffect(() => {
    void fetch('/api/info')
      .then((response) => response.json())
      .then((value: unknown) => setOidc(ServerInfo.parse(value).oidc))
      .catch(() => setError('Could not reach the server.'))
  }, [])
  const destination = () => {
    const target = new URLSearchParams(window.location.search).get('redirect')
    return target?.startsWith('/device') && !target.startsWith('//') ? target : '/device'
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setBusy(true)
    const form = new FormData(event.currentTarget)
    try {
      await authRequest(signup ? '/sign-up/email' : '/sign-in/email', {
        email: form.get('email'),
        password: form.get('password'),
        ...(signup ? { name: form.get('name') } : {}),
      })
      window.location.assign(destination())
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Sign in failed.')
      setBusy(false)
    }
  }
  async function companyLogin() {
    try {
      const result = z.object({ url: z.url() }).parse(
        await authRequest('/sign-in/oauth2', {
          providerId: 'company',
          callbackURL: destination(),
        }),
      )
      window.location.assign(result.url)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Company login failed.')
    }
  }
  return (
    <main className="card">
      <a className="brand" href="/">
        huddle<span>●</span>
      </a>
      <h1>{signup ? 'Create your account.' : 'Welcome back.'}</h1>
      <p>Sign in to authorize your Huddle desktop.</p>
      <form onSubmit={submit}>
        {signup && (
          <label>
            Name
            <input name="name" autoComplete="name" required maxLength={80} />
          </label>
        )}
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete={signup ? 'new-password' : 'current-password'}
            minLength={12}
            required
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button disabled={busy}>
          {busy ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}
        </button>
      </form>
      {oidc && (
        <button className="secondary" onClick={() => void companyLogin()}>
          Continue with company login
        </button>
      )}
      <button className="text" onClick={() => setSignup(!signup)}>
        {signup ? 'Already have an account? Sign in' : 'New here? Create an account'}
      </button>
    </main>
  )
}
