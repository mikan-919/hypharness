import { inertia } from '@hono/inertia'
import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { csrf } from 'hono/csrf'
import { createMiddleware } from 'hono/factory'
import type { Accounts, RelyingParty, User } from './accounts'
import type { Agent, Codex } from './agent'
import { rootView } from './renderer'

type AppEnv = { Bindings: Env; Variables: { user: User } }

// cf の型生成は自分自身の Durable Object にクラス型を付けないため、ここで型を与える
const accounts = (env: Env) =>
  (env.ACCOUNTS as DurableObjectNamespace<Accounts>).getByName('default')
const codex = (c: Context<AppEnv>) =>
  (c.env.CODEX as DurableObjectNamespace<Codex>).getByName(c.var.user.id)

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

const routes = app
  .get('/', auth, async (c) =>
    c.render('Home', {
      user: c.var.user,
      codexConnected: await codex(c).connected(),
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
  .post('/codex/device', auth, async (c) =>
    c.json(await codex(c).startDevice()),
  )
  .post('/codex/device/poll', auth, async (c) =>
    c.json({ status: await codex(c).pollDevice() }),
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
    // 記憶はアカウントとエージェント名の組ごとのインスタンスに分ける
    const agent = (c.env.AGENT as DurableObjectNamespace<Agent>).getByName(
      `${c.var.user.id}/${name}`,
    )
    return c.json({ reply: await agent.chat(c.var.user.id, message) })
  })
  .get('/agents/:name/memories', auth, async (c) =>
    c.json(
      await (c.env.AGENT as DurableObjectNamespace<Agent>)
        .getByName(`${c.var.user.id}/${c.req.param('name')}`)
        .memories(),
    ),
  )

export default routes
export { Accounts } from './accounts'
export { Agent, Codex } from './agent'
