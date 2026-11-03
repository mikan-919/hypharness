import { inertia } from '@hono/inertia'
import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { csrf } from 'hono/csrf'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { Accounts, RelyingParty, User } from './accounts'
import type { Relay } from './relay'
import { rootView } from './renderer'

type AppEnv = { Bindings: Env; Variables: { user: User } }

// cf の型生成は自分自身の Durable Object にクラス型を付けないため、ここで型を与える
const accounts = (env: Env) =>
  (env.ACCOUNTS as DurableObjectNamespace<Accounts>).getByName('default')

const relay = (env: Env, userId: string) =>
  (env.RELAY as DurableObjectNamespace<Relay>).getByName(userId)

const relyingParty = (c: Context): RelyingParty => {
  const url = new URL(c.req.url)
  return { rpID: url.hostname, origin: url.origin }
}

const auth = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, 'session')
  const user = token ? await accounts(c.env).session(token) : null
  if (!user) {
    return c.req.method === 'GET'
      ? c.redirect('/login')
      : c.json({ error: 'ログインしてください' }, 401)
  }
  c.set('user', user)
  await next()
})

const startSession = (
  c: Context,
  result: { token: string; expires: number } | { error: string },
) => {
  if ('error' in result) return c.json(result, 400)
  setCookie(c, 'session', result.token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    expires: new Date(result.expires),
  })
  return c.json({ ok: true })
}

const app = new Hono<AppEnv>()

app.use(csrf())
app.use(inertia({ rootView }))
// Durable Object や外部 API で出た例外の内容を、画面が読める JSON で返す
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  console.error(err)
  return c.json({ error: err.message }, 500)
})

// 暗号化した作業領域の大きさの上限
const CHECKPOINT_LIMIT = 10 * 1024 * 1024

const toHex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

// チェックポイントの読み書きの対象。ノードのトークンと、そのノードが今の実行権を持つことを確かめる
async function checkpointTarget(c: Context<AppEnv>) {
  const token = c.req.header('Authorization')?.replace(/^Bearer /, '')
  const owner = token ? await accounts(c.env).nodeOwner(token) : null
  if (!owner) return c.json({ error: 'ノード用トークンが不正です' }, 401)
  const id = Number(c.req.param('id'))
  const generation = Number(c.req.param('generation'))
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(generation)) {
    return c.json({ error: 'タスクの番号か世代が不正です' }, 400)
  }
  const stub = relay(c.env, owner.userId)
  if (!(await stub.holds(id, generation, owner.node.id))) {
    return c.json({ error: '実行権を持っていません' }, 409)
  }
  return {
    relay: stub,
    id,
    generation,
    node: owner.node.id,
    key: `${owner.userId}/${id}`,
  }
}

// 中継に置くタスクの大きさの上限
const STATEMENT_LIMIT = 20_000
const CHECK_LIMIT = 2_000

const routes = app
  .get('/', auth, async (c) =>
    c.render('Home', {
      user: c.var.user,
      status: await relay(c.env, c.var.user.id).status(),
    }),
  )
  .get('/status', auth, async (c) =>
    c.json(await relay(c.env, c.var.user.id).status()),
  )
  .post('/tasks', auth, async (c) => {
    const { statement, check } = await c.req.json<{
      statement?: unknown
      check?: unknown
    }>()
    if (
      typeof statement !== 'string' ||
      !statement.trim() ||
      statement.length > STATEMENT_LIMIT
    ) {
      return c.json(
        { error: `課題文を${STATEMENT_LIMIT}文字以内で指定してください` },
        400,
      )
    }
    if (
      check !== undefined &&
      (typeof check !== 'string' || check.length > CHECK_LIMIT)
    ) {
      return c.json(
        { error: `判定コマンドは${CHECK_LIMIT}文字以内の文字列です` },
        400,
      )
    }
    return c.json({
      id: await relay(c.env, c.var.user.id).add(
        statement,
        check?.trim() || null,
      ),
    })
  })
  .get('/tasks/:id/history', auth, async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isSafeInteger(id)) {
      return c.json({ error: 'タスクの番号が不正です' }, 400)
    }
    return c.json(await relay(c.env, c.var.user.id).history(id))
  })
  .get('/login', (c) => c.render('Login'))
  .post('/auth/register/options', async (c) => {
    const { name } = await c.req.json<{ name?: unknown }>()
    if (typeof name !== 'string' || !/^\S{1,32}$/.test(name)) {
      return c.json({ error: '名前は空白なしの32文字以内にしてください' }, 400)
    }
    const result = await accounts(c.env).registrationOptions(
      name,
      relyingParty(c),
    )
    return c.json(result, 'error' in result ? 400 : 200)
  })
  .post('/auth/register', async (c) => {
    const { challengeId, response } = await c.req.json()
    return startSession(
      c,
      await accounts(c.env).register(challengeId, response, relyingParty(c)),
    )
  })
  .post('/auth/login/options', async (c) =>
    c.json(await accounts(c.env).authenticationOptions(relyingParty(c))),
  )
  .post('/auth/login', async (c) => {
    const { challengeId, response } = await c.req.json()
    return startSession(
      c,
      await accounts(c.env).authenticate(
        challengeId,
        response,
        relyingParty(c),
      ),
    )
  })
  .post('/auth/logout', async (c) => {
    const token = getCookie(c, 'session')
    if (token) await accounts(c.env).logout(token)
    deleteCookie(c, 'session', { path: '/' })
    return c.json({ ok: true })
  })
  // ノードのペアリング。申し込みと受け取りはログインしていないノードから届く
  .post('/node/pairings', async (c) => {
    const { name } = await c.req.json<{ name?: unknown }>()
    if (typeof name !== 'string' || !/^[\w.-]{1,64}$/.test(name)) {
      return c.json(
        { error: 'name は英数字と _ . - の64文字以内にしてください' },
        400,
      )
    }
    return c.json(await accounts(c.env).startPairing(name))
  })
  .post('/node/pairings/claim', async (c) => {
    const { id } = await c.req.json<{ id?: unknown }>()
    if (typeof id !== 'string') {
      return c.json({ error: 'id に文字列を指定してください' }, 400)
    }
    const result = await accounts(c.env).claimPairing(id)
    return c.json(result, 'error' in result ? 410 : 200)
  })
  .post('/node/pairings/approve', auth, async (c) => {
    const { code } = await c.req.json<{ code?: unknown }>()
    if (typeof code !== 'string') {
      return c.json({ error: 'code に文字列を指定してください' }, 400)
    }
    return (await accounts(c.env).approvePairing(code.trim(), c.var.user.id))
      ? c.json({ ok: true })
      : c.json({ error: 'コードが見つからないか、有効期限が切れています' }, 400)
  })
  // ノードが WebSocket で接続する。Cookie ではなくノード用トークンで認証し、
  // ノードの ID と名前は中継へのヘッダーで渡す。ノードが送ったヘッダーは上書きする
  // チェックポイントは、そのタスクの今の実行権を持つノードだけが読み書きできる。中身はノードが暗号化しており、中継は復号できない
  .put('/node/checkpoints/:id/:generation', async (c) => {
    const target = await checkpointTarget(c)
    if (target instanceof Response) return target
    const declared = Number(c.req.header('content-length'))
    if (!(declared > 0 && declared <= CHECKPOINT_LIMIT)) {
      return c.json(
        { error: `チェックポイントは ${CHECKPOINT_LIMIT} バイトまでです` },
        413,
      )
    }
    const body = await c.req.arrayBuffer()
    if (body.byteLength > CHECKPOINT_LIMIT) {
      return c.json(
        { error: `チェックポイントは ${CHECKPOINT_LIMIT} バイトまでです` },
        413,
      )
    }
    const hash = toHex(await crypto.subtle.digest('SHA-256', body))
    await c.env.CHECKPOINTS.put(target.key, body)
    const ok = await target.relay.checkpoint(
      target.id,
      target.generation,
      target.node,
      hash,
    )
    if (!ok) return c.json({ error: '実行権を持っていません' }, 409)
    return c.json({ hash })
  })
  .get('/node/checkpoints/:id/:generation', async (c) => {
    const target = await checkpointTarget(c)
    if (target instanceof Response) return target
    const object = await c.env.CHECKPOINTS.get(target.key)
    if (!object) return c.json({ error: 'チェックポイントがありません' }, 404)
    return new Response(object.body)
  })
  .get('/node/socket', async (c) => {
    const token = c.req.header('Authorization')?.replace(/^Bearer /, '')
    const owner = token ? await accounts(c.env).nodeOwner(token) : null
    if (!owner) return c.json({ error: 'ノード用トークンが不正です' }, 401)
    const headers = new Headers(c.req.raw.headers)
    headers.set('x-node-id', owner.node.id)
    headers.set('x-node-name', owner.node.name)
    return relay(c.env, owner.userId).fetch(new Request(c.req.raw, { headers }))
  })

export default routes
export { Accounts } from './accounts'
export { Relay } from './relay'
