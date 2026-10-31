import { DurableObject } from 'cloudflare:workers'
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'

const CHALLENGE_TTL = 5 * 60_000
const SESSION_TTL = 30 * 24 * 60 * 60_000

export type User = { id: string; name: string }
// 想定内の失敗（名前の重複、検証の失敗、期限切れ）は error で返し、それ以外は例外にする
type Result = { token: string; expires: number } | { error: string }
// WebAuthn の検証に使う、要求元の URL から決まる値
export type RelyingParty = { rpID: string; origin: string }

// アカウント、passkey、セッションを1か所で持つ。ログイン時は passkey の ID からアカウントを引くため分けない
export class Accounts extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS passkeys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL,
        transports TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY,
        challenge TEXT NOT NULL,
        user_id TEXT,
        name TEXT,
        expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        expires INTEGER NOT NULL
      );
    `)
  }

  async registrationOptions(name: string, { rpID }: RelyingParty) {
    if (this.userByName(name)) return { error: 'この名前は登録済みです' }
    const userId = crypto.randomUUID()
    const options = await generateRegistrationOptions({
      rpName: 'hypharness',
      rpID,
      userName: name,
      userID: new TextEncoder().encode(userId),
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'preferred',
      },
    })
    return {
      challengeId: this.saveChallenge(options.challenge, userId, name),
      options,
    }
  }

  async register(
    challengeId: string,
    response: RegistrationResponseJSON,
    { rpID, origin }: RelyingParty,
  ): Promise<Result> {
    const challenge = this.takeChallenge(challengeId)
    if (!challenge?.user_id || !challenge.name) {
      return { error: '登録の有効期限が切れました' }
    }
    const { verified, registrationInfo } = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    })
    if (!verified) return { error: 'passkey を検証できませんでした' }
    if (this.userByName(challenge.name))
      return { error: 'この名前は登録済みです' }

    const { credential } = registrationInfo
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        'INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)',
        challenge.user_id,
        challenge.name,
        Date.now(),
      )
      this.ctx.storage.sql.exec(
        'INSERT INTO passkeys (id, user_id, public_key, counter, transports) VALUES (?, ?, ?, ?, ?)',
        credential.id,
        challenge.user_id,
        credential.publicKey,
        credential.counter,
        JSON.stringify(credential.transports ?? []),
      )
    })
    return this.createSession(challenge.user_id)
  }

  async authenticationOptions({ rpID }: RelyingParty) {
    // 端末に保存された passkey から選ばせるため、allowCredentials は指定しない
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'preferred',
    })
    return { challengeId: this.saveChallenge(options.challenge), options }
  }

  async authenticate(
    challengeId: string,
    response: AuthenticationResponseJSON,
    { rpID, origin }: RelyingParty,
  ): Promise<Result> {
    const challenge = this.takeChallenge(challengeId)
    if (!challenge) return { error: 'ログインの有効期限が切れました' }
    const passkey = this.ctx.storage.sql
      .exec<{
        id: string
        user_id: string
        public_key: ArrayBuffer
        counter: number
        transports: string
      }>('SELECT * FROM passkeys WHERE id = ?', response.id)
      .toArray()[0]
    if (!passkey) return { error: '登録されていない passkey です' }

    const { verified, authenticationInfo } = await verifyAuthenticationResponse(
      {
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: passkey.id,
          publicKey: new Uint8Array(passkey.public_key),
          counter: passkey.counter,
          transports: JSON.parse(passkey.transports),
        },
      },
    )
    if (!verified) return { error: 'passkey を検証できませんでした' }
    this.ctx.storage.sql.exec(
      'UPDATE passkeys SET counter = ? WHERE id = ?',
      authenticationInfo.newCounter,
      passkey.id,
    )
    return this.createSession(passkey.user_id)
  }

  async session(token: string): Promise<User | null> {
    const row = this.ctx.storage.sql
      .exec<User>(
        `SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = ? AND s.expires > ?`,
        await hash(token),
        Date.now(),
      )
      .toArray()[0]
    return row ?? null
  }

  async logout(token: string) {
    this.ctx.storage.sql.exec(
      'DELETE FROM sessions WHERE id = ?',
      await hash(token),
    )
  }

  private userByName(name: string) {
    return this.ctx.storage.sql
      .exec('SELECT 1 FROM users WHERE name = ?', name)
      .toArray().length
  }

  private saveChallenge(challenge: string, userId?: string, name?: string) {
    const id = crypto.randomUUID()
    this.ctx.storage.sql.exec(
      'INSERT INTO challenges (id, challenge, user_id, name, expires) VALUES (?, ?, ?, ?, ?)',
      id,
      challenge,
      userId ?? null,
      name ?? null,
      Date.now() + CHALLENGE_TTL,
    )
    return id
  }

  // challenge は1回だけ使えるよう、取り出すと同時に消す
  private takeChallenge(id: string) {
    this.ctx.storage.sql.exec(
      'DELETE FROM challenges WHERE expires <= ?',
      Date.now(),
    )
    return this.ctx.storage.sql
      .exec<{ challenge: string; user_id: string | null; name: string | null }>(
        'DELETE FROM challenges WHERE id = ? RETURNING challenge, user_id, name',
        id,
      )
      .toArray()[0]
  }

  // Cookie にはトークンを、DB にはそのハッシュを置く。DB が漏れてもセッションを乗っ取れない
  private async createSession(userId: string) {
    const token = crypto.randomUUID()
    const expires = Date.now() + SESSION_TTL
    this.ctx.storage.sql.exec(
      'INSERT INTO sessions (id, user_id, expires) VALUES (?, ?, ?)',
      await hash(token),
      userId,
      expires,
    )
    return { token, expires }
  }
}

async function hash(token: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  )
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
