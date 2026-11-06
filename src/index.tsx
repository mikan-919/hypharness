import { inertia } from '@hono/inertia'
import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { csrf } from 'hono/csrf'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { Accounts, RelyingParty, User } from './accounts'
import { type Relay, sessionName } from './relay'
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
// 暗号化した試行の中身（課題・候補のコード・作業領域のリポジトリ）と結果（差分・モデルの呼び出しの記録）の大きさの上限
const TRIAL_LIMIT = 50 * 1024 * 1024

// R2 の置き場は内容の SHA-256 で決める（CAS）。同じ中身は1つだけ置き、キーから中身の取り違えを確かめられる
const casKey = (userId: string, hash: string) => `${userId}/cas/${hash}`

// ノード用トークンを確かめ、ノードとその利用者を返す
async function nodeOwner(c: Context<AppEnv>) {
  const token = c.req.header('Authorization')?.replace(/^Bearer /, '')
  return token ? await accounts(c.env).nodeOwner(token) : null
}

// 本文を上限つきで読み、R2 に内容の SHA-256 で置く。上限を超えたら null
async function putBlob(c: Context<AppEnv>, userId: string, limit: number) {
  const declared = Number(c.req.header('content-length'))
  if (!(declared > 0 && declared <= limit)) return null
  const body = await c.req.arrayBuffer()
  if (body.byteLength > limit) return null
  const hash = toHex(await crypto.subtle.digest('SHA-256', body))
  await c.env.CHECKPOINTS.put(casKey(userId, hash), body)
  return hash
}

async function getBlob(
  c: Context<AppEnv>,
  userId: string,
  hash: string | null,
) {
  const object = hash ? await c.env.CHECKPOINTS.get(casKey(userId, hash)) : null
  if (!object) return c.json({ error: '中身がありません' }, 404)
  return new Response(object.body)
}

const toHex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

// チェックポイントの読み書きの対象。ノードのトークンと、そのノードが今の実行権を持つことを確かめる
async function checkpointTarget(c: Context<AppEnv>) {
  const owner = await nodeOwner(c)
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
    userId: owner.userId,
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
  // 固定部の変更の提案を承認する。中継は依頼を残してノードに送り、ノードが PR を作る
  .post('/proposals/approve', auth, async (c) => {
    const { session, id } = await c.req.json<{
      session?: unknown
      id?: unknown
    }>()
    if (!sessionName(session) || !Number.isSafeInteger(id)) {
      return c.json({ error: 'セッションと提案の番号を指定してください' }, 400)
    }
    return (await relay(c.env, c.var.user.id).approve(session, id as number))
      ? c.json({ ok: true })
      : c.json({ error: '承認を待つ提案がありません' }, 404)
  })
  // 利用者の中継の記録とチェックポイントをすべて消す。アカウントとノードのペアリングは残す
  .post('/reset', auth, async (c) => {
    const prefix = `${c.var.user.id}/`
    let cursor: string | undefined
    do {
      const page = await c.env.CHECKPOINTS.list({ prefix, cursor })
      if (page.objects.length) {
        await c.env.CHECKPOINTS.delete(page.objects.map((o) => o.key))
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    await relay(c.env, c.var.user.id).wipe()
    return c.json({ ok: true })
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
    const hash = await putBlob(c, target.userId, CHECKPOINT_LIMIT)
    if (!hash) {
      return c.json(
        { error: `チェックポイントは ${CHECKPOINT_LIMIT} バイトまでです` },
        413,
      )
    }
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
    return getBlob(c, target.userId, await target.relay.checkpointOf(target.id))
  })
  // 計測の試行（図の実験配置）。計測するノードが暗号化した中身を置いて待ち行列に入れ、実行権を持つノードが中身を読んで解き、
  // 暗号化した結果を置く。中継は鍵を持たず、ハッシュと状態だけを持つ
  .post('/node/trials', async (c) => {
    const owner = await nodeOwner(c)
    if (!owner) return c.json({ error: 'ノード用トークンが不正です' }, 401)
    const hash = await putBlob(c, owner.userId, TRIAL_LIMIT)
    if (!hash) {
      return c.json(
        { error: `試行の中身は ${TRIAL_LIMIT} バイトまでです` },
        413,
      )
    }
    return c.json({ id: await relay(c.env, owner.userId).addTrial(hash) })
  })
  .get('/node/trials/:id', async (c) => {
    const owner = await nodeOwner(c)
    if (!owner) return c.json({ error: 'ノード用トークンが不正です' }, 401)
    const id = Number(c.req.param('id'))
    if (!Number.isSafeInteger(id)) {
      return c.json({ error: '試行の番号が不正です' }, 400)
    }
    const trial = await relay(c.env, owner.userId).trial(id)
    if (!trial) return c.json({ error: '試行がありません' }, 404)
    return c.json(trial)
  })
  .get('/node/trials/:id/result', async (c) => {
    const owner = await nodeOwner(c)
    if (!owner) return c.json({ error: 'ノード用トークンが不正です' }, 401)
    const trial = await relay(c.env, owner.userId).trial(
      Number(c.req.param('id')),
    )
    return getBlob(c, owner.userId, trial?.result ?? null)
  })
  .get('/node/trials/:id/:generation/payload', async (c) => {
    const target = await checkpointTarget(c)
    if (target instanceof Response) return target
    const trial = await target.relay.trial(target.id)
    return getBlob(c, target.userId, trial?.payload ?? null)
  })
  .put('/node/trials/:id/:generation/result', async (c) => {
    const target = await checkpointTarget(c)
    if (target instanceof Response) return target
    const hash = await putBlob(c, target.userId, TRIAL_LIMIT)
    if (!hash) {
      return c.json(
        { error: `試行の結果は ${TRIAL_LIMIT} バイトまでです` },
        413,
      )
    }
    const ok = await target.relay.result(
      target.id,
      target.generation,
      target.node,
      hash,
    )
    if (!ok) return c.json({ error: '実行権を持っていません' }, 409)
    return c.json({ hash })
  })
  .get('/node/socket', async (c) => {
    const owner = await nodeOwner(c)
    if (!owner) return c.json({ error: 'ノード用トークンが不正です' }, 401)
    const headers = new Headers(c.req.raw.headers)
    headers.set('x-node-id', owner.node.id)
    headers.set('x-node-name', owner.node.name)
    return relay(c.env, owner.userId).fetch(new Request(c.req.raw, { headers }))
  })

export default routes
export { Accounts } from './accounts'
export { Relay } from './relay'
