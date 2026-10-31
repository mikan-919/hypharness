import { DurableObject } from 'cloudflare:workers'
import { accountIdFromToken, readOutputText } from './lib'

const AUTH_URL = 'https://auth.openai.com'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const MODEL = 'gpt-6.1-terra'

type Credential = {
  access: string
  refresh: string
  expires: number
  accountId: string
}
type Device = { deviceAuthId: string; userCode: string }

export type Message = { role: 'user' | 'assistant'; content: string }

// 1アカウントの ChatGPT ログインを持つ。refresh token は更新のたびに入れ替わるため、
// 更新はこのインスタンスだけが行う
export class Codex extends DurableObject<Env> {
  async connected() {
    return (await this.ctx.storage.get('credential')) !== undefined
  }

  // device code フロー: 利用者が表示されたコードを auth.openai.com で入力する
  async startDevice() {
    const response = await fetch(
      `${AUTH_URL}/api/accounts/deviceauth/usercode`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID }),
      },
    )
    if (!response.ok) {
      throw new Error(
        `コードの発行に失敗しました (${response.status}): ${await response.text()}`,
      )
    }
    const json = await response.json<{
      device_auth_id: string
      user_code: string
      interval: string | number
    }>()
    await this.ctx.storage.put<Device>('device', {
      deviceAuthId: json.device_auth_id,
      userCode: json.user_code,
    })
    return {
      userCode: json.user_code,
      verificationUrl: `${AUTH_URL}/codex/device`,
      interval: Number(json.interval),
    }
  }

  async pollDevice(): Promise<'pending' | 'connected'> {
    const device = await this.ctx.storage.get<Device>('device')
    if (!device) throw new Error('コードが発行されていません')
    const response = await fetch(`${AUTH_URL}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: device.deviceAuthId,
        user_code: device.userCode,
      }),
    })
    // 利用者がまだコードを入力していない
    if (response.status === 403 || response.status === 404) return 'pending'
    if (!response.ok) {
      throw new Error(
        `認証の確認に失敗しました (${response.status}): ${await response.text()}`,
      )
    }
    const code = await response.json<{
      authorization_code: string
      code_verifier: string
    }>()
    const credential = await requestToken({
      grant_type: 'authorization_code',
      code: code.authorization_code,
      code_verifier: code.code_verifier,
      redirect_uri: `${AUTH_URL}/deviceauth/callback`,
    })
    await this.ctx.storage.put('credential', credential)
    await this.ctx.storage.delete('device')
    return 'connected'
  }

  credential() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.ctx.storage.get<Credential>('credential')
      if (!current) throw new Error('Codex が接続されていません')
      if (current.expires - Date.now() > 5 * 60_000) return current
      const next = await requestToken({
        grant_type: 'refresh_token',
        refresh_token: current.refresh,
      })
      await this.ctx.storage.put('credential', next)
      return next
    })
  }
}

async function requestToken(params: Record<string, string>) {
  const response = await fetch(`${AUTH_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: CLIENT_ID }),
  })
  if (!response.ok) {
    throw new Error(
      `トークンの取得に失敗しました (${response.status}): ${await response.text()}`,
    )
  }
  const token = await response.json<{
    access_token: string
    refresh_token: string
    expires_in: number
  }>()
  return {
    access: token.access_token,
    refresh: token.refresh_token,
    expires: Date.now() + token.expires_in * 1000,
    accountId: accountIdFromToken(token.access_token),
  }
}

export async function complete(
  codex: DurableObjectStub<Codex>,
  instructions: string,
  input: Message[],
) {
  const { access, accountId } = await codex.credential()
  const response = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${access}`,
      'chatgpt-account-id': accountId,
      'OpenAI-Beta': 'responses=experimental',
      originator: 'hypharness',
      accept: 'text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      store: false,
      stream: true,
      instructions,
      input,
    }),
  })
  if (!response.ok) {
    throw new Error(
      `モデルの呼び出しに失敗しました (${response.status}): ${await response.text()}`,
    )
  }
  return readOutputText(await response.text())
}
