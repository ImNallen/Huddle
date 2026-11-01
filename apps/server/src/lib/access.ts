import { AccessCommand, AccessView, type AccessStage, Avatar, PublicUser } from '@huddle/contracts'
import { auth } from './auth'
import { delivery } from './auth-bridge'
import { config } from './config'
import { db } from './db'
import { setupRequired } from './admission'
import { changePassword, joinAccount, setupAccount, signInAccount, type Login } from './friends'
import { AccessFailure, limit, transaction } from './access-store'

export async function requireAccess(headers: Headers) {
  const session = await auth.api.getSession({ headers })
  if (!session) throw new AccessFailure('reauth_required')
  const result = await db.query('SELECT avatar FROM account_security WHERE user_id=$1', [
    session.user.id,
  ])
  const avatar = Avatar.safeParse(result.rows[0]?.avatar)
  if (!avatar.success) throw new AccessFailure('reauth_required')
  return { ...session, user: PublicUser.parse({ ...session.user, avatar: avatar.data }) }
}
async function optionalPrincipal(request: Request) {
  try {
    return await requireAccess(request.headers)
  } catch (error) {
    if (error instanceof AccessFailure) return null
    throw error
  }
}
function respond(
  request: Request,
  view: AccessView,
  options: {
    session?: NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>
    clear?: boolean
  } = {},
) {
  const native = request.headers.get('x-huddle-client') === 'native'
  if (native && options.session) view.bearerToken = options.session.session.token
  return delivery.run({ view, native, session: options.session, clear: options.clear }, () =>
    auth.handler(
      new Request(`${config.SERVER_URL}/api/auth/huddle/response`, { headers: request.headers }),
    ),
  )
}
async function entry(): Promise<AccessStage> {
  return { kind: (await setupRequired()) ? 'setup' : 'signin' }
}
async function issueSession(userId: string, request: Request) {
  const ctx = await auth.$context
  const user = await ctx.internalAdapter.findUserById(userId)
  if (!user) throw new AccessFailure('invalid')
  const session = await ctx.internalAdapter.createSession(userId, false, {
    userAgent: request.headers.get('user-agent') ?? '',
  })
  if (!session) throw new AccessFailure('unavailable')
  return { user, session }
}
async function signIn(request: Request, login: Login) {
  const session = await issueSession(login.userId, request)
  // A password change that commits between the password check and this session's insert would
  // miss the session, so wait out any pending change and drop the session if the password moved on.
  const unchanged = await db.query(
    'SELECT 1 FROM login WHERE user_id=$1 AND password_hash=$2 FOR SHARE',
    [login.userId, login.passwordHash],
  )
  if (!unchanged.rowCount) {
    await db.query('DELETE FROM session WHERE id=$1', [session.session.id])
    throw new AccessFailure('invalid')
  }
  return respond(request, await readyView(login.userId), { session })
}
async function readyView(userId: string): Promise<AccessView> {
  const result = await db.query(
    'SELECT u.id,u.name,a.avatar FROM "user" u JOIN account_security a ON a.user_id=u.id WHERE u.id=$1',
    [userId],
  )
  return { stage: { kind: 'ready', user: PublicUser.parse(result.rows[0]) } }
}
async function advance(request: Request, command: AccessCommand): Promise<Response> {
  const actor = await optionalPrincipal(request)
  if (command.kind === 'signout') {
    if (actor) await db.query('DELETE FROM session WHERE id=$1', [actor.session.id])
    return respond(request, { stage: await entry() }, { clear: true })
  }
  if (command.kind === 'account.setup') return signIn(request, await setupAccount(command))
  if (command.kind === 'account.join') return signIn(request, await joinAccount(command))
  if (command.kind === 'account.signin')
    return signIn(request, await signInAccount(command.username, command.password))
  if (!actor) throw new AccessFailure('reauth_required')
  switch (command.kind) {
    case 'profile.save':
      await transaction(async (sql) => {
        if (command.profile.avatar.kind === 'photo') {
          const photo = await sql.query('SELECT id FROM account_photo WHERE id=$1 AND user_id=$2', [
            command.profile.avatar.uploadId,
            actor.user.id,
          ])
          if (!photo.rowCount) throw new AccessFailure('invalid')
        }
        await sql.query('UPDATE "user" SET name=$2,"updatedAt"=now() WHERE id=$1', [
          actor.user.id,
          command.profile.name,
        ])
        await sql.query('UPDATE account_security SET avatar=$2 WHERE user_id=$1', [
          actor.user.id,
          JSON.stringify(command.profile.avatar),
        ])
      })
      break
    case 'session.revoke':
      await db.query('DELETE FROM session WHERE id=$1 AND "userId"=$2 AND id<>$3', [
        command.id,
        actor.user.id,
        actor.session.id,
      ])
      break
    case 'sessions.revoke-others':
      await db.query('DELETE FROM session WHERE "userId"=$1 AND id<>$2', [
        actor.user.id,
        actor.session.id,
      ])
      break
    case 'password.change':
      await changePassword(actor.user.id, actor.session.id, command.current, command.next)
      break
  }
  return respond(request, await readyView(actor.user.id))
}
export async function accessRequest(request: Request, trustedIp?: string) {
  if (request.method === 'GET') {
    const actor = await optionalPrincipal(request)
    return respond(request, {
      stage: actor ? { kind: 'ready', user: actor.user } : await entry(),
    })
  }
  if (request.method !== 'POST') throw new AccessFailure('invalid')
  const body = await request.text()
  if (body.length > 16000) throw new AccessFailure('invalid')
  const command = AccessCommand.parse(JSON.parse(body))
  if (command.kind === 'account.setup' || command.kind === 'account.join')
    await limit(`account-ip:${trustedIp ?? 'unavailable'}`, 10, 900)
  if (command.kind === 'account.signin') {
    await limit(`signin-ip:${trustedIp ?? 'unavailable'}`, 30, 900)
    await limit(`signin-user:${command.username}`, 10, 900)
  }
  return advance(request, command)
}
