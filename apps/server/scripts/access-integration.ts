import assert from 'node:assert/strict'
import { randomUUID, randomBytes, generateKeyPairSync, createHash, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { z } from 'zod'
import { execFileSync } from 'node:child_process'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { TOTP } from 'otpauth'
import {
  AccessView,
  AccountSecurity,
  DeviceCode,
  DeviceToken,
  Snapshot,
  type AccessCommand,
} from '@huddle/contracts'
import {
  Client,
  emailCode,
  invite,
  mailIds,
  migratedDatabase,
  startServer,
  syntheticEmail,
} from './harness'

const setupCode = `access-${randomUUID()}`
const database = await migratedDatabase()
const server = await startServer({
  databaseUrl: database.url,
  port: Number(process.env.TEST_PORT ?? 3200),
  entry: 'scripts/access-test-server.ts',
  env: { SETUP_CODE: setupCode },
}).catch(async (error: unknown) => {
  await database.drop()
  throw error
})
const base = server.origin
const scratchEnv = { ...process.env, DATABASE_URL: database.url, SERVER_URL: base }
try {
  async function enrollAccount(client: Client, email: string, begin: AccessCommand) {
    const sentAt = Date.now()
    const seen = await mailIds(email)
    await client.act(begin)
    let view = await client.act({ kind: 'email.verify', code: await emailCode(email, seen) })
    assert.equal(view.stage.kind, 'enroll')
    assert.equal((await client.call('/api/snapshot')).response.status, 401)
    if (view.stage.kind !== 'enroll') throw new Error('Enrollment missing')
    const oldGeneration = view.stage.generation
    view = await client.act({ kind: 'enrollment.refresh' })
    if (view.stage.kind !== 'enroll') throw new Error('Enrollment missing')
    assert.notEqual(view.stage.generation, oldGeneration)
    const secret = view.stage.secret
    const authenticator = new TOTP({ secret, algorithm: 'SHA1', digits: 6, period: 30 })
    const enrolledCode = authenticator.generate()
    view = await client.act({
      kind: 'enrollment.verify',
      generation: view.stage.generation,
      code: enrolledCode,
    })
    assert.equal(view.stage.kind, 'save-recovery')
    if (view.stage.kind !== 'save-recovery') throw new Error('Recovery missing')
    const codes = view.stage.codes
    assert.equal((await client.call('/api/snapshot')).response.status, 401)
    await client.act({ kind: 'recovery.ack', batch: view.stage.batch })
    await client.act({ kind: 'passkey.skip' })
    view = await client.act({
      kind: 'profile.save',
      profile: {
        name: 'Synthetic member',
        avatar: { kind: 'mascot', shape: 'flower', color: 'rose' },
      },
    })
    assert.equal(view.stage.kind, 'ready')
    const inventory = AccountSecurity.parse((await client.call('/api/account')).value)
    assert.equal(inventory.recoveryRemaining, 10)
    assert.equal(inventory.user.avatar.kind, 'mascot')
    return { email, authenticator, codes, enrolledCode, sentAt }
  }
  const browser = new Client(base)
  const adminEmail = syntheticEmail('access')
  const account = await enrollAccount(browser, adminEmail, {
    kind: 'setup.start',
    code: setupCode,
    serverName: 'Access server',
    email: adminEmail,
  })
  assert(browser.cookies.size > 0)
  assert.equal(browser.token, '')
  const native = new Client(base, true)
  const nativeEmail = syntheticEmail('access')
  await invite(browser, nativeEmail)
  await enrollAccount(native, nativeEmail, { kind: 'email.send', email: nativeEmail })
  assert(native.token.length > 0)
  const seat = Snapshot.parse((await browser.call('/api/snapshot')).value).server
  assert.equal(seat.role, 'admin')
  assert.equal(seat.memberCount, 2)
  assert.equal(seat.channelCount, 0)
  for (const path of [
    '/sign-in/email',
    '/sign-up/email',
    '/email-otp/sign-in',
    '/two-factor/disable',
    '/huddle/response',
    '/huddle/continuation',
  ]) {
    assert.equal((await browser.call(`/api/auth${path}`, {})).response.status, 400)
  }
  const device = DeviceCode.parse(
    (await native.call('/api/auth/device/code', { client_id: 'huddle-desktop' })).value,
  )
  await browser.act({ kind: 'device.decide', userCode: device.user_code, decision: 'approve' })
  const granted = DeviceToken.parse(
    (
      await native.call('/api/auth/device/token', {
        device_code: device.device_code,
        client_id: 'huddle-desktop',
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      })
    ).value,
  )
  const deviceClient = new Client(base, true)
  deviceClient.token = granted.access_token
  assert.equal((await deviceClient.call('/api/snapshot')).response.status, 200)
  assert.equal(
    (
      await native.call('/api/auth/device/token', {
        device_code: device.device_code,
        client_id: 'huddle-desktop',
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      })
    ).response.status,
    400,
  )
  const replay = await browser.call('/api/access', {
    kind: 'security.commit',
    change: { kind: 'sessions.revoke-others' },
    proof: { kind: 'totp', code: account.enrolledCode },
  })
  assert.equal(replay.response.status, 400)
  process.stdout.write(
    'PASS cookie/native SMTP enrollment, refresh, staged admission, recovery inventory, denied raw routes, device grant single-use and TOTP replay.\n',
  )
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = keys.publicKey.export({ format: 'jwk' })
  const id = randomBytes(32)
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x ?? '', 'base64url')],
      [-3, Buffer.from(jwk.y ?? '', 'base64url')],
    ]),
  )
  const hash = (input: string | Buffer) => createHash('sha256').update(input).digest()
  const rpHash = hash(new URL(base).hostname)
  const encode = (input: unknown) => Buffer.from(JSON.stringify(input)).toString('base64url')
  const length = Buffer.alloc(2)
  length.writeUInt16BE(id.length)
  function registration(challenge: string, uv: boolean) {
    const authData = Buffer.concat([
      rpHash,
      Buffer.from([uv ? 0x45 : 0x41]),
      Buffer.alloc(4),
      Buffer.alloc(16),
      length,
      id,
      cose,
    ])
    const attestation = isoCBOR.encode(
      new Map<string, string | Uint8Array | Map<string, string>>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    )
    return {
      id: id.toString('base64url'),
      rawId: id.toString('base64url'),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: encode({ type: 'webauthn.create', challenge, origin: base }),
        attestationObject: Buffer.from(attestation).toString('base64url'),
        transports: ['internal'],
      },
    }
  }
  function authentication(challenge: string, uv: boolean, counter: number) {
    const count = Buffer.alloc(4)
    count.writeUInt32BE(counter)
    const authenticatorData = Buffer.concat([rpHash, Buffer.from([uv ? 5 : 1]), count])
    const clientDataJSON = encode({ type: 'webauthn.get', challenge, origin: base })
    const signature = sign(
      'sha256',
      Buffer.concat([authenticatorData, hash(Buffer.from(clientDataJSON, 'base64url'))]),
      keys.privateKey,
    )
    return {
      id: id.toString('base64url'),
      rawId: id.toString('base64url'),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON,
        authenticatorData: authenticatorData.toString('base64url'),
        signature: signature.toString('base64url'),
      },
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 30050 - (Date.now() % 30000)))
  const optionResult = await browser.call('/api/access/passkey/register/options', {
    name: 'Cryptographic fixture',
    proof: { kind: 'totp', code: account.authenticator.generate() },
  })
  assert.equal(optionResult.response.status, 200)
  const options = z.object({ challenge: z.string() }).parse(optionResult.value)
  assert.equal(
    (
      await browser.call(
        '/api/access/passkey/register/verify',
        registration(options.challenge, false),
      )
    ).response.ok,
    false,
  )
  assert.equal(
    (
      await browser.call(
        '/api/access/passkey/register/verify',
        registration(options.challenge, true),
      )
    ).response.status,
    200,
  )
  const passkeyClient = new Client(base)
  const signInOptions = z
    .object({ challenge: z.string() })
    .parse(
      (await passkeyClient.call('/api/access/passkey/authenticate/options', { purpose: 'signin' }))
        .value,
    )
  assert.equal(
    (
      await passkeyClient.call('/api/access/passkey/authenticate/verify', {
        purpose: 'signin',
        response: authentication(signInOptions.challenge, false, 1),
      })
    ).response.ok,
    false,
  )
  const valid = await passkeyClient.call('/api/access/passkey/authenticate/verify', {
    purpose: 'signin',
    response: authentication(signInOptions.challenge, true, 1),
  })
  assert.equal(valid.response.status, 200)
  assert.equal(AccessView.parse(valid.value).stage.kind, 'ready')
  assert.equal(
    (
      await passkeyClient.call('/api/access/passkey/authenticate/verify', {
        purpose: 'signin',
        response: authentication(signInOptions.challenge, true, 1),
      })
    ).response.ok,
    false,
  )
  assert.equal((await deviceClient.call('/api/snapshot')).response.status, 401)
  const reauth = z
    .object({ challenge: z.string() })
    .parse(
      (await passkeyClient.call('/api/access/passkey/authenticate/options', { purpose: 'reauth' }))
        .value,
    )
  const proof = z.object({ proof: z.string() }).parse(
    (
      await passkeyClient.call('/api/access/passkey/authenticate/verify', {
        purpose: 'reauth',
        response: authentication(reauth.challenge, true, 2),
      })
    ).value,
  )
  await passkeyClient.act({
    kind: 'security.commit',
    change: { kind: 'passkey.rename', id: id.toString('base64url'), name: 'Renamed fixture' },
    proof: { kind: 'passkey', proof: proof.proof },
  })
  assert.equal(
    (
      await passkeyClient.call('/api/access', {
        kind: 'security.commit',
        change: { kind: 'sessions.revoke-others' },
        proof: { kind: 'passkey', proof: proof.proof },
      })
    ).response.ok,
    false,
  )
  process.stdout.write(
    'PASS cryptographically valid WebAuthn UV registration/login, missing UV rejection, challenge replay, single-use reauthentication and epoch revocation. These are software fixtures, not platform authenticator tests.\n',
  )

  const regenerationOptions = z
    .object({ challenge: z.string() })
    .parse(
      (await passkeyClient.call('/api/access/passkey/authenticate/options', { purpose: 'reauth' }))
        .value,
    )
  const regenerationProof = z.object({ proof: z.string() }).parse(
    (
      await passkeyClient.call('/api/access/passkey/authenticate/verify', {
        purpose: 'reauth',
        response: authentication(regenerationOptions.challenge, true, 3),
      })
    ).value,
  )
  const unsaved = await passkeyClient.act({
    kind: 'security.commit',
    change: { kind: 'recovery.regenerate' },
    proof: { kind: 'passkey', proof: regenerationProof.proof },
  })
  assert(unsaved.stage.kind === 'save-recovery')
  const resumed = new Client(base)
  const resumeOptions = z
    .object({ challenge: z.string() })
    .parse(
      (await resumed.call('/api/access/passkey/authenticate/options', { purpose: 'signin' })).value,
    )
  const resumedView = AccessView.parse(
    (
      await resumed.call('/api/access/passkey/authenticate/verify', {
        purpose: 'signin',
        response: authentication(resumeOptions.challenge, true, 4),
      })
    ).value,
  )
  assert(resumedView.stage.kind === 'save-recovery')
  assert.equal(resumedView.stage.batch, unsaved.stage.batch)
  assert.equal((await resumed.call('/api/snapshot')).response.status, 401)
  assert.equal((await passkeyClient.call('/api/snapshot')).response.status, 401)
  await resumed.act({ kind: 'recovery.ack', batch: resumedView.stage.batch })
  assert.equal((await passkeyClient.call('/api/snapshot')).response.status, 200)
  process.stdout.write(
    'PASS pending recovery acknowledgement survives a separate verified login and denies both sessions until the matching batch is acknowledged.\n',
  )
  const photo = await sharp({
    create: { width: 32, height: 32, channels: 3, background: '#346bf1' },
  })
    .png()
    .toBuffer()
  const form = new FormData()
  form.set('photo', new File([new Uint8Array(photo)], 'avatar.png', { type: 'image/png' }))
  const cookieHeader = () =>
    [...passkeyClient.cookies].map(([key, value]) => `${key}=${value}`).join('; ')
  const upload = await fetch(`${base}/api/account/photo`, {
    method: 'POST',
    headers: { Origin: base, Cookie: cookieHeader() },
    body: form,
  })
  assert.equal(upload.status, 200)
  const uploaded = z.object({ uploadId: z.string() }).parse(await upload.json())
  await passkeyClient.act({
    kind: 'profile.save',
    profile: { name: 'Photo member', avatar: { kind: 'photo', uploadId: uploaded.uploadId } },
  })
  const image = await fetch(`${base}/api/account/photo/${uploaded.uploadId}`, {
    headers: { Cookie: cookieHeader() },
  })
  assert.equal(image.status, 200)
  assert.equal((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).format, 'webp')
  assert.equal((await native.call(`/api/account/photo/${uploaded.uploadId}`)).response.ok, true)
  assert.equal(
    (await new Client(base).call(`/api/account/photo/${uploaded.uploadId}`)).response.ok,
    false,
  )
  const invalidForm = new FormData()
  invalidForm.set(
    'photo',
    new File(['<svg><script>bad()</script></svg>'], 'avatar.svg', { type: 'image/svg+xml' }),
  )
  assert.equal(
    (
      await fetch(`${base}/api/account/photo`, {
        method: 'POST',
        headers: { Origin: base, Cookie: cookieHeader() },
        body: invalidForm,
      })
    ).ok,
    false,
  )
  process.stdout.write(
    'PASS photo decode/reencode, persisted profile, visibility to fellow members but not anonymous callers, and active SVG rejection.\n',
  )
  await passkeyClient.act({ kind: 'reset.request', email: account.email })
  const resetRequests = z
    .array(z.object({ id: z.string() }))
    .parse(
      JSON.parse(
        execFileSync(
          process.execPath,
          ['--import', 'tsx', 'scripts/account-reset.ts', 'list', account.email],
          { encoding: 'utf8', env: scratchEnv },
        ),
      ),
    )
  const resetId = resetRequests[0]?.id
  assert(resetId)
  const capabilityPath = join(tmpdir(), `huddle-reset-${randomUUID()}`)
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/account-reset.ts',
      'issue',
      resetId,
      'synthetic-operator',
      'Synthetic fixture independently confirmed by test operator',
      capabilityPath,
    ],
    { env: { ...scratchEnv, HUDDLE_IDENTITY_CONFIRMED: 'yes' }, stdio: 'pipe' },
  )
  const capability = (await readFile(capabilityPath, 'utf8')).trim()
  await unlink(capabilityPath)
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, 61000 - (Date.now() - account.sentAt))),
  )
  const recovered = new Client(base, true)
  const resetSeen = await mailIds(account.email)
  await recovered.act({ kind: 'reset.redeem', capability })
  let resetView = await recovered.act({
    kind: 'email.verify',
    code: await emailCode(account.email, resetSeen),
  })
  assert(resetView.stage.kind === 'enroll')
  resetView = await recovered.act({
    kind: 'enrollment.verify',
    generation: resetView.stage.generation,
    code: new TOTP({
      secret: resetView.stage.secret,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    }).generate(),
  })
  assert(resetView.stage.kind === 'save-recovery')
  await recovered.act({ kind: 'recovery.ack', batch: resetView.stage.batch })
  const resetInventory = AccountSecurity.parse((await recovered.call('/api/account')).value)
  assert.equal(resetInventory.passkeys.length, 0)
  assert.equal(resetInventory.recoveryRemaining, 10)
  assert.equal((await passkeyClient.call('/api/snapshot')).response.status, 401)
  assert.equal(
    (await new Client(base, true).call('/api/access', { kind: 'reset.redeem', capability }))
      .response.status,
    400,
  )
  process.stdout.write(
    'PASS operator-confirmed capability, fresh email and enrollment, local passkey revocation, old-session rejection and reset single use.\n',
  )

  if (process.env.ACCESS_TEST_STATE)
    await writeFile(process.env.ACCESS_TEST_STATE, JSON.stringify({ localToken: native.token }), {
      mode: 0o600,
    })
} catch (error) {
  process.stderr.write(server.logs())
  throw error
} finally {
  await server.stop()
  await database.drop()
}
