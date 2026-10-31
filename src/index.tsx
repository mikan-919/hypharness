import { inertia } from '@hono/inertia'
import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { csrf } from 'hono/csrf'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { Accounts, RelyingParty, User } from './accounts'
import { rootView } from './renderer'
import type { Runner } from './runner'

type AppEnv = { Bindings: Env; Variables: { user: User } }

// cf の型生成は自分自身の Durable Object にクラス型を付けないため、ここで型を与える
const accounts = (env: Env) =>
  (env.ACCOUNTS as DurableObjectNamespace<Accounts>).getByName('default')

const runner = (env: Env, userId: string) =>
  (env.RUNNER as DurableObjectNamespace<Runner>).getByName(userId)

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
      runnerConnected: await runner(c.env, c.var.user.id).connected(),
    }),
  )
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
  // ランナーのペアリング。申し込みと受け取りはログインしていないランナーから届く
  .post('/runner/pairings', async (c) =>
    c.json(await accounts(c.env).startPairing()),
  )
  .post('/runner/pairings/claim', async (c) => {
    const { id } = await c.req.json<{ id?: unknown }>()
    if (typeof id !== 'string') {
      return c.json({ error: 'id に文字列を指定してください' }, 400)
    }
    const result = await accounts(c.env).claimPairing(id)
    return c.json(result, 'error' in result ? 410 : 200)
  })
  .post('/runner/pairings/approve', auth, async (c) => {
    const { code } = await c.req.json<{ code?: unknown }>()
    if (typeof code !== 'string') {
      return c.json({ error: 'code に文字列を指定してください' }, 400)
    }
    return (await accounts(c.env).approvePairing(code.trim(), c.var.user.id))
      ? c.json({ ok: true })
      : c.json({ error: 'コードが見つからないか、有効期限が切れています' }, 400)
  })
  // 手元のランナーが WebSocket で接続する。Cookie ではなくランナー用トークンで認証する
  .get('/runner/socket', async (c) => {
    const token = c.req.header('Authorization')?.replace(/^Bearer /, '')
    const user = token ? await accounts(c.env).runnerUser(token) : null
    if (!user) return c.json({ error: 'ランナー用トークンが不正です' }, 401)
    return runner(c.env, user.id).fetch(c.req.raw)
  })
  // 経済のループ。状態と操作はランナーにあり、Worker は中継する
  .get('/economy', auth, async (c) => {
    const stub = runner(c.env, c.var.user.id)
    return c.render('Economy', {
      status: (await stub.connected())
        ? await stub.call({ method: 'status' })
        : null,
    })
  })
  .get('/economy/status', auth, async (c) =>
    c.json(await runner(c.env, c.var.user.id).call({ method: 'status' })),
  )
  .post('/economy/goal', auth, async (c) => {
    const { goal } = await c.req.json<{ goal?: unknown }>()
    if (typeof goal !== 'string' || !goal.trim()) {
      return c.json({ error: '目的を入力してください' }, 400)
    }
    return c.json(
      await runner(c.env, c.var.user.id).call({ method: 'setGoal', goal }),
    )
  })
  .post('/economy/step', auth, async (c) =>
    c.json(await runner(c.env, c.var.user.id).call({ method: 'step' })),
  )
  .post('/agents/:name/chat', auth, async (c) => {
    const name = c.req.param('name')
    const { message } = await c.req.json<{ message?: unknown }>()
    if (!/^[\w-]{1,32}$/.test(name)) {
      return c.json(
        { error: 'エージェント名は英数字と _ - の32文字以内です' },
        400,
      )
    }
    if (typeof message !== 'string' || !message.trim()) {
      return c.json({ error: 'message に文字列を指定してください' }, 400)
    }
    // エージェントの記憶と処理はランナーにあるため、ランナーが止まっていると応答できない
    const stub = runner(c.env, c.var.user.id)
    if (!(await stub.connected())) {
      return c.json({ error: 'ランナーが接続されていません' }, 503)
    }
    return c.body(await stub.chat(name, message), 200, {
      'content-type': 'application/x-ndjson',
    })
  })

export default routes
export { Accounts } from './accounts'
export { Runner } from './runner'
