import { AccessCommand, type AccessStage } from '@huddle/contracts'
import { setupRequired } from './admission'
import { joinAccount, setupAccount } from './accounts'
import { AccessFailure, limit, transaction } from './access-store'
import { identify, type Visitor } from './identity'

async function stageFor(visitor: Visitor): Promise<AccessStage> {
  switch (visitor.kind) {
    case 'no-identity':
      return visitor
    case 'member':
      return { kind: 'ready', login: visitor.login, user: visitor.user }
    case 'stranger':
      return {
        kind: (await setupRequired()) ? 'setup' : 'join',
        login: visitor.login,
        suggestedName: visitor.suggestedName,
      }
  }
}

async function advance(visitor: Visitor, command: AccessCommand, headers: Headers) {
  if (visitor.kind === 'no-identity') throw new AccessFailure('no_access')
  switch (command.kind) {
    case 'account.setup':
    case 'account.join':
      if (visitor.kind === 'member') return stageFor(visitor)
      await limit(`account:${visitor.login}`, 10, 900)
      if (command.kind === 'account.setup') await setupAccount(visitor.login, command)
      else await joinAccount(visitor.login, command)
      break
    case 'profile.save': {
      if (visitor.kind !== 'member' || headers.get('x-huddle-user') !== visitor.user.id)
        throw new AccessFailure('no_access')
      const { name, avatar } = command.profile
      await transaction(async (sql) => {
        if (avatar.kind === 'photo') {
          const photo = await sql.query('SELECT id FROM account_photo WHERE id=$1 AND user_id=$2', [
            avatar.uploadId,
            visitor.user.id,
          ])
          if (!photo.rowCount) throw new AccessFailure('invalid')
        }
        await sql.query('UPDATE "user" SET name=$2,"updatedAt"=now() WHERE id=$1', [
          visitor.user.id,
          name,
        ])
        await sql.query('UPDATE account_security SET avatar=$2 WHERE user_id=$1', [
          visitor.user.id,
          JSON.stringify(avatar),
        ])
      })
    }
  }
  return stageFor(await identify(headers))
}

export async function accessRequest(request: Request): Promise<Response> {
  const visitor = await identify(request.headers)
  if (request.method === 'GET') return Response.json(await stageFor(visitor))
  if (request.method !== 'POST') throw new AccessFailure('invalid')
  const expected = request.headers.get('x-huddle-user')
  if (expected !== null && (visitor.kind !== 'member' || visitor.user.id !== expected))
    throw new AccessFailure('no_access')
  const body = await request.text()
  if (body.length > 16000) throw new AccessFailure('invalid')
  const command = AccessCommand.parse(JSON.parse(body))
  return Response.json(await advance(visitor, command, request.headers))
}
