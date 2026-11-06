import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import { createStore } from './store.ts'
import { type Call, runTopic } from './topic.ts'

const reply = (name: string, args: object, id = name) =>
  ({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] }) as unknown as AssistantMessage

const adr = reply('write_doc', { path: 'docs/adr/0001-x.md', content: '# 0001 x' })

// 決めた順にツールを呼ぶモデルの代わり。受け取った会話を残し、応答を使い切ったら止まる
function script(...replies: AssistantMessage[]) {
  const seen: Message[][] = []
  const call: Call = async ({ context }) => {
    seen.push([...context.messages])
    const next = replies.shift()
    if (!next) throw new Error('用意した応答を使い切った')
    return next
  }
  return { call, seen }
}

const setup = (file?: string) => {
  const store = createStore(file)
  if (!store.hasTopic('goal')) store.addTopic({ id: 'goal', title: '最終目的', state: 'asking', ready: false })
  return store
}

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
