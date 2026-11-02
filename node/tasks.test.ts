import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { attempt } from './measure'
import { type Budget, type Complete, serveModel } from './model'
import { type EvalTask, validate } from './tasks'

const task = (t: Partial<EvalTask>): EvalTask => ({
  statement: 'answer.txt に 42 と書いてください',
  files: {},
  check: 'test "$(cat answer.txt)" = 42',
  check_files: {},
  solution: { 'answer.txt': '42' },
  ...t,
})
const always = async () => true

test('模範解答が通らない課題・空の解答で通る課題・目的に関係しない課題を除く', async () => {
  expect(await validate(task({}), always)).toBeNull()
  expect(
    await validate(task({ solution: { 'answer.txt': '41' } }), always),
  ).toBe('模範解答が判定を通りません')
  expect(await validate(task({ check: 'true' }), always)).toBe(
    '空の解答が判定を通ります',
  )
  expect(await validate(task({}), async () => false)).toBe(
    '最終目的に関係しません',
  )
  // 作業用ディレクトリの外を指すファイル名は受け付けない
  await expect(
    validate(task({ solution: { '../x': '42' } }), always),
  ).rejects.toThrow('ファイル名が不正です')
})

const reply = (content: AssistantMessage['content'], cost = 0) =>
  ({
    role: 'assistant',
    content,
    usage: { cost: { total: cost } },
    stopReason: content.length ? 'toolUse' : 'stop',
  }) as AssistantMessage

test('予算を使い切った後の呼び出しは拒否する', async () => {
  const socket = join(await mkdtemp(join(tmpdir(), 'hyph-test-')), 'm.sock')
  const budget: Budget = { limit: 2, spent: 0 }
  const server = serveModel(
    socket,
    async () => reply([], 1),
    budget,
    () => {},
  )
  const call = () =>
    fetch('http://model/', {
      method: 'POST',
      unix: socket,
      body: JSON.stringify({ messages: [] }),
    }).then((r) => r.status)
  expect(await call()).toBe(200)
  expect(await call()).toBe(200)
  expect(await call()).toBe(402)
  expect(budget.spent).toBe(2)
  server.stop(true)
})

test('判定用ファイルは解答役から読めず、上書きしても判定には効かない', async () => {
  const secret = task({
    statement: 'answer.txt に 42 と書いてください',
    check:
      'test "$(cat answer.txt)" = 42 && test "$(cat key.txt)" = SECRET-MARKER',
    check_files: { 'key.txt': 'SECRET-MARKER' },
  })
  // 台本どおりに答える偽のモデル。判定用ファイルと候補のコードを探し、書き換えようとしてから解答する
  const script = [
    'cat key.txt; find / -xdev -name key.txt 2>/dev/null; grep -rs SECRET-MARKER /work /agent /tmp /task.md /home /root',
    'echo forged > key.txt; touch /agent/x && echo agent-writable; echo 42 > answer.txt',
  ]
  const contexts: Context[] = []
  const complete: Complete = async (context) => {
    contexts.push(structuredClone(context))
    const command = script[contexts.length - 1]
    return command
      ? reply([
          {
            type: 'toolCall',
            id: String(contexts.length),
            name: 'sh',
            arguments: { command },
          },
        ])
      : reply([{ type: 'toolCall', id: 'f', name: 'finish', arguments: {} }])
  }
  const dir = await mkdtemp(join(tmpdir(), 'hyph-test-'))
  const result = await attempt(
    secret,
    join(import.meta.dir, '../agent'),
    complete,
    { limit: null, spent: 0 },
    () => {},
    join(dir, 'agent.log'),
  )
  expect(result).toEqual({ ok: true, code: 0 })
  // 台本のコマンド文字列は除き、ツールの結果だけを見る
  const outputs = JSON.stringify(
    contexts.at(-1)?.messages.filter((m) => m.role === 'toolResult'),
  )
  expect(outputs).not.toContain('SECRET-MARKER')
  expect(outputs).not.toContain('agent-writable')
}, 120_000)
