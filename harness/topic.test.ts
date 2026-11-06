import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Context, Message } from '@earendil-works/pi-ai'
import { createStore } from './store.ts'
import { type Call, runTopic, TOOLS } from './topic.ts'

const reply = (name: string, args: object, id = name) =>
  ({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] }) as unknown as AssistantMessage

const adr = reply('write_doc', { path: 'docs/adr/0001-x.md', content: '# 0001 x' })

// 決めた順にツールを呼ぶモデルの代わり。受け取った会話を残し、応答を使い切ったら止まる
function script(...replies: AssistantMessage[]) {
  const seen: Message[][] = []
  const contexts: Context[] = []
  const call: Call = async ({ context }) => {
    seen.push([...context.messages])
    contexts.push(context)
    const next = replies.shift()
    if (!next) throw new Error('用意した応答を使い切った')
    return next
  }
  return { call, seen, contexts }
}

const setup = (file?: string) => {
  const store = createStore(file)
  if (!store.hasTopic('goal')) store.addTopic({ id: 'goal', title: '最終目的', state: 'asking', ready: false })
  return store
}

// 環境変数と fetch を差し替えてから body を動かし、終わったら戻す
async function withSearch(handler: (url: any, init: any) => Response | Promise<Response>, body: (sent: any[]) => Promise<void>) {
  const savedKey = process.env.PARALLEL_API_KEY
  const savedFetch = globalThis.fetch
  process.env.PARALLEL_API_KEY = 'test-key'
  const sent: any[] = []
  globalThis.fetch = (async (url: any, init: any) => {
    sent.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
  try {
    await body(sent)
  } finally {
    globalThis.fetch = savedFetch
    if (savedKey === undefined) delete process.env.PARALLEL_API_KEY
    else process.env.PARALLEL_API_KEY = savedKey
  }
}

const searchResult = (store: ReturnType<typeof setup>) =>
  store
    .transcript('goal')!
    .filter((m) => m.role === 'toolResult' && m.toolName === 'web_search')
    .at(-1) as any

const ok = (results: unknown) => () => new Response(JSON.stringify({ results }), { status: 200 })

test('PARALLEL_API_KEY があるときだけツールの一覧に web_search を加える', async () => {
  const saved = process.env.PARALLEL_API_KEY
  try {
    process.env.PARALLEL_API_KEY = 'test-key'
    expect(TOOLS().map((t) => t.name)).toContain('web_search')
    delete process.env.PARALLEL_API_KEY
    expect(TOOLS().map((t) => t.name)).not.toContain('web_search')

    // 鍵が無いときは、runTopic がモデルに渡す一覧にも入らない
    const store = setup()
    const { call, contexts } = script(adr, reply('ready', {}))
    await runTopic(store, call, 'goal', mkdtempSync(join(tmpdir(), 'hyph-')))
    expect(contexts[0].tools?.map((t) => t.name)).not.toContain('web_search')
  } finally {
    if (saved === undefined) delete process.env.PARALLEL_API_KEY
    else process.env.PARALLEL_API_KEY = saved
  }
})

test('web_search は mode fast と既定の max_results を送り、応答を title・url・抜粋にする', async () => {
  await withSearch(ok([{ title: 'T1', url: 'https://a.example', excerpts: ['e1', 'e2'] }, { title: 'T2', url: 'https://b.example', excerpts: ['e3'] }]), async (sent) => {
    const store = setup()
    const { call, contexts } = script(reply('web_search', { objective: '調べる' }), adr, reply('ready', {}))
    await runTopic(store, call, 'goal', mkdtempSync(join(tmpdir(), 'hyph-')))
    expect(contexts[0].tools?.map((t) => t.name)).toContain('web_search')
    expect(sent[0].url).toBe('https://api.parallel.ai/v1beta/search')
    expect(sent[0].init.method).toBe('POST')
    expect(sent[0].init.headers['x-api-key']).toBe('test-key')
    expect(sent[0].init.headers['content-type']).toBe('application/json')
    expect(JSON.parse(sent[0].init.body)).toEqual({ objective: '調べる', max_results: 5, mode: 'fast' })
    const result = searchResult(store)
    expect(result.isError).toBe(false)
    expect(result.content[0].text).toBe('T1\nhttps://a.example\ne1\ne2\n\nT2\nhttps://b.example\ne3')
  })
})

test('web_search は max_results を 1〜20 に丸め、0 件なら「結果なし」を返す', async () => {
  await withSearch(ok([]), async (sent) => {
    const store = setup()
    const { call } = script(reply('web_search', { objective: '調べる', max_results: 99 }), adr, reply('ready', {}))
    await runTopic(store, call, 'goal', mkdtempSync(join(tmpdir(), 'hyph-')))
    expect(JSON.parse(sent[0].init.body).max_results).toBe(20)
    expect(searchResult(store).content[0].text).toBe('結果なし')
  })
  await withSearch(ok([]), async (sent) => {
    const store = setup()
    const { call } = script(reply('web_search', { objective: '調べる', max_results: -3 }), adr, reply('ready', {}))
    await runTopic(store, call, 'goal', mkdtempSync(join(tmpdir(), 'hyph-')))
    expect(JSON.parse(sent[0].init.body).max_results).toBe(1)
  })
})

test('web_search の HTTP 500 は isError の結果になり、fail に理由を残して対話を続ける', async () => {
  await withSearch(() => new Response('{"error":"boom"}', { status: 500 }), async () => {
    const store = setup()
    const { call } = script(reply('web_search', { objective: '調べる' }), adr, reply('ready', {}))
    await runTopic(store, call, 'goal', mkdtempSync(join(tmpdir(), 'hyph-')))
    const result = searchResult(store)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('500')
    const fail = store.snapshot().entries.find((e) => e.evidence === 'Parallel の検索')
    expect(fail?.kind).toBe('fail')
    expect(fail?.text).toContain('500')
    expect(store.snapshot().topics[0].ready).toBe(true)
  })
})

test('web_search は 8,000 文字を超える応答を切る', async () => {
  await withSearch(ok([{ title: 'T', url: 'https://a.example', excerpts: ['x'.repeat(9_000)] }]), async () => {
    const store = setup()
    const { call } = script(reply('web_search', { objective: '調べる' }), adr, reply('ready', {}))
    await runTopic(store, call, 'goal', mkdtempSync(join(tmpdir(), 'hyph-')))
    expect(searchResult(store).content[0].text.length).toBe(8_000)
  })
})

test('質問に答えを受け取り、ADR を書いて ready で終える', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hyph-'))
  const store = setup()
  const { call, seen } = script(
    reply('ask', { text: 'どこに残しますか', options: [], recommendation: '理由' }),
    reply('record', { kind: 'done', text: 'ファイルに残す', evidence: '利用者の答え' }),
    adr,
    reply('ready', {}),
  )
  const done = runTopic(store, call, 'goal', repo)
  await Bun.sleep(0)
  expect(store.snapshot().queue).toEqual(['q1'])
  expect(store.snapshot().topics[0].state).toBe('asking')
  expect(store.answer('q1', 'ファイル')).toEqual({ ok: true, waiting: true })
  await done
  expect(store.snapshot().topics[0]).toMatchObject({ state: 'ready', ready: true })
  expect(store.snapshot().entries.map((e) => e.text)).toEqual(['ファイルに残す'])
  expect(JSON.stringify(seen[1])).toContain('利用者の答え: ファイル')
  expect(await Bun.file(join(repo, 'docs/adr/0001-x.md')).text()).toBe('# 0001 x')
})

test('ADR を書かずに ready を繰り返したら詰まりにして止める', async () => {
  const store = setup()
  const { call } = script(...[1, 2, 3, 4].map((i) => reply('ready', {}, `r${i}`)))
  await runTopic(store, call, 'goal', tmpdir())
  expect(store.snapshot().topics[0].state).toBe('blocked')
  expect(store.snapshot().entries.at(-1)?.text).toContain('ready')
})

test('リポジトリの外は読ませず、ADR と用語集のほかは書かせない', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hyph-'))
  const { call, seen } = script(
    reply('read_file', { path: '../../../etc/passwd' }),
    reply('write_doc', { path: 'src/index.ts', content: 'x' }),
  )
  await runTopic(setup(), call, 'goal', repo)
  expect(JSON.stringify(seen[1])).toContain('リポジトリの外です')
  expect(JSON.stringify(seen[2])).toContain('書けるのは')
  expect(await Bun.file(join(repo, 'src/index.ts')).exists()).toBe(false)
})

test('再起動の後、答え待ちの質問を出し直さずに続きから進める', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hyph-')), 'dialog.json')
  const first = setup(file)
  const ask = reply('ask', { text: 'どこに残しますか', options: [], recommendation: '理由' })
  void runTopic(first, script(ask).call, 'goal', tmpdir())
  await Bun.sleep(0)
  expect(first.snapshot().queue).toEqual(['q1'])

  const second = setup(file)
  const { call, seen } = script(adr, reply('ready', {}))
  const done = runTopic(second, call, 'goal', mkdtempSync(join(tmpdir(), 'hyph-')))
  await Bun.sleep(0)
  expect(second.snapshot().questions.length).toBe(1)
  expect(second.answer('q1', 'ファイル')).toEqual({ ok: true, waiting: true })
  await done
  expect(second.snapshot().topics[0].ready).toBe(true)
  expect(JSON.stringify(seen[0])).toContain('利用者の答え: ファイル')
})

test('本文は版が古い書き換えを断り、戻すことも履歴に残す', () => {
  const store = setup()
  expect(store.editGoal('a', 0, 'user', '最初')).toMatchObject({ ok: true, version: 1 })
  expect(store.editGoal('b', 0, 'goal', '古い版')).toMatchObject({ ok: false, version: 1, text: 'a' })
  expect(store.editGoal('a\nb', 1, 'goal', '足す')).toMatchObject({ ok: true, version: 2 })
  expect(store.snapshot().edits[1].diff).toEqual([
    { op: ' ', line: 'a' },
    { op: '+', line: 'b' },
  ])
  expect(store.revert('v2')).toMatchObject({ ok: true, version: 3, text: 'a' })
  expect(store.snapshot().edits.at(-1)).toMatchObject({ author: 'user', reason: 'v2 の前の版に戻した' })
})

test('利用者の書き換えを差分でエージェントに渡し、エージェントは読んだ版で書き換える', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hyph-'))
  const goalFile = join(dir, 'FINAL_GOAL.md')
  await Bun.write(goalFile, '対話を見返したい')
  const store = createStore(undefined, goalFile)
  store.addTopic({ id: 'goal', title: '最終目的', state: 'asking', ready: false })
  const { call, seen } = script(
    reply('edit_goal', { version: 1, content: '対話を見返したい\n保存先: ファイル', reason: '保存先を決めた' }),
    adr,
    reply('ready', {}),
  )
  await runTopic(store, call, 'goal', dir)
  expect(JSON.stringify(seen[0])).toContain('+ 対話を見返したい')
  // 自分の書き換えは差分として戻ってこない
  expect(JSON.stringify(seen[1]).split('書き換えられた').length).toBe(2)
  expect(JSON.stringify(seen[0])).not.toContain('- ')
  expect(await Bun.file(goalFile).text()).toBe('対話を見返したい\n保存先: ファイル')
  expect(store.snapshot().edits.map((e) => e.author)).toEqual(['user', 'goal'])
})

test('待つエージェントがいなくても答えを保存し、続きから進めるときに渡す', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hyph-')), 'dialog.json')
  const first = setup(file)
  const ask = reply('ask', { text: 'どこに残しますか', options: [], recommendation: '理由' })
  void runTopic(first, script(ask).call, 'goal', tmpdir())
  await Bun.sleep(0)

  const second = setup(file)
  expect(second.answer('q1', '')).toEqual({ ok: false, waiting: false })
  expect(second.answer('q1', 'ファイル')).toEqual({ ok: true, waiting: false })
  expect(second.snapshot().queue).toEqual([])
  const { call, seen } = script(adr, reply('ready', {}))
  await runTopic(second, call, 'goal', mkdtempSync(join(tmpdir(), 'hyph-')))
  expect(second.snapshot().topics[0].ready).toBe(true)
  expect(JSON.stringify(seen[0])).toContain('利用者の答え: ファイル')
})
