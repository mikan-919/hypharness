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
    const { command } = await c.req.json<{ command?: unknown }>()
    if (typeof command !== 'string' || !command.trim()) {
      return c.json({ error: 'command に文字列を指定してください' }, 400)
    }
    return c.json({ id: await relay(c.env, c.var.user.id).add(command) })
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
