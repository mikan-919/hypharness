import { expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Context, ToolCall } from '@earendil-works/pi-ai'
import { attempt } from './measure'
import { type Budget, type Complete, serveModel } from './model'
import { diff, type EvalTask, generate, prepare, validate } from './tasks'

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
  ).toStartWith('模範解答が判定を通りません')
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
  expect(result).toEqual({ ok: true, code: 0, patch: null })
  // 台本のコマンド文字列は除き、ツールの結果だけを見る
  const outputs = JSON.stringify(
    contexts.at(-1)?.messages.filter((m) => m.role === 'toolResult'),
  )
  expect(outputs).not.toContain('SECRET-MARKER')
  expect(outputs).not.toContain('agent-writable')
}, 120_000)

test('生成役は除外の理由を受け取り、出し直した課題で採用数を満たせる', async () => {
  const submit = (statement: string) =>
    reply([
      {
        type: 'toolCall',
        id: statement,
        name: 'submit_task',
        arguments: { ...task({ statement }) },
      },
    ])
  const contexts: Context[] = []
  const complete: Complete = async (context) => {
    contexts.push(structuredClone(context))
    return submit(contexts.length === 1 ? '最初の課題' : '直した課題')
  }
  const result = await generate('目的', 1, complete, async (t) =>
    t.statement === '最初の課題' ? '判定の出力: No tests found!' : null,
  )
  expect(result).toEqual({ submitted: 2, accepted: 1 })
  // 2回目の呼び出しで、生成役は1回目の除外の理由を見ている
  expect(JSON.stringify(contexts[1].messages.at(-1))).toContain(
    'No tests found!',
  )
})

test('採用が足りないまま文章だけで応答した生成役に、出し直しを促す', async () => {
  let calls = 0
  const complete: Complete = async () => {
    calls++
    return calls === 1
      ? reply([{ type: 'text', text: 'これ以上は難しくできません' }])
      : reply([
          {
            type: 'toolCall',
            id: 'x',
            name: 'submit_task',
            arguments: { ...task({}) },
          },
        ])
  }
  expect(await generate('目的', 1, complete, async () => null)).toEqual({
    submitted: 1,
    accepted: 1,
  })
})

test('1回の応答の課題は並列に選別し、結果は提出の順に返す', async () => {
  const contexts: Context[] = []
  const complete: Complete = async (context) => {
    contexts.push(structuredClone(context))
    return reply(
      ['遅い', '速い'].map((statement) => ({
        type: 'toolCall' as const,
        id: statement,
        name: 'submit_task',
        arguments: { ...task({ statement }) },
      })),
    )
  }
  let running = 0
  let peak = 0
  const accept = async (t: { statement: string }) => {
    peak = Math.max(peak, ++running)
    await Bun.sleep(t.statement === '遅い' ? 50 : 0)
    running--
    return t.statement === '遅い' ? '遅い課題は除外' : null
  }
  expect(await generate('目的', 2, complete, accept)).toEqual({
    submitted: 4,
    accepted: 2,
  })
  expect(peak).toBe(2)
  // 2回目の呼び出しで、生成役は1回目の結果を提出の順に受け取っている
  const results = contexts[1].messages.filter((m) => m.role === 'toolResult')
  expect(results.map((m) => m.toolCallId)).toEqual(['遅い', '速い'])
})

test('モデルの一時的な障害は再試行し、回復しなければ障害として残し、それ以外の失敗はそのまま返す', async () => {
  const socket = join(await mkdtemp(join(tmpdir(), 'hyph-test-')), 'm.sock')
  const failure = (errorMessage: string): AssistantMessage => ({
    ...reply([]),
    stopReason: 'error',
    errorMessage,
  })
  const serve = (answers: (() => AssistantMessage)[]) => {
    const budget: Budget = { limit: null, spent: 0 }
    let i = 0
    const server = serveModel(
      socket,
      async () => answers[Math.min(i++, answers.length - 1)](),
      budget,
      () => {},
      [0, 0, 0],
    )
    const call = () =>
      fetch('http://model/', {
        method: 'POST',
        unix: socket,
        body: JSON.stringify({ messages: [] }),
      })
    return { budget, server, call, count: () => i }
  }
  const timeout = () => {
    throw new DOMException('The operation timed out.', 'TimeoutError')
  }

  const recovered = serve([
    () => failure('OpenAI API error (504): Gateway time-out'),
    timeout,
    () => reply([]),
  ])
  expect((await recovered.call()).status).toBe(200)
  expect(recovered.budget.outage).toBeUndefined()
  recovered.server.stop(true)

  const down = serve([() => failure('OpenAI API error (503): unavailable')])
  expect((await down.call()).status).toBe(503)
  expect(down.count()).toBe(4)
  expect(down.budget.outage).toContain('503')
  down.server.stop(true)

  const invalid = serve([
    () => failure('OpenAI API error (400): context too long'),
  ])
  const res = await invalid.call()
  expect(res.status).toBe(200)
  expect(((await res.json()) as AssistantMessage).stopReason).toBe('error')
  expect(invalid.count()).toBe(1)
  invalid.server.stop(true)
})

test('モデル中継は、1回の試行の呼び出しに同じキャッシュの鍵を付け、試行ごとに別の鍵にする', async () => {
  const keys: (string | undefined)[] = []
  const complete: Complete = async (_, options) => {
    keys.push(options?.sessionId)
    return reply([])
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const socket = join(await mkdtemp(join(tmpdir(), 'hyph-test-')), 'm.sock')
    const server = serveModel(
      socket,
      complete,
      { limit: null, spent: 0 },
      () => {},
    )
    for (let i = 0; i < 2; i++) {
      await fetch('http://model/', {
        method: 'POST',
        unix: socket,
        body: JSON.stringify({ messages: [] }),
      })
    }
    server.stop(true)
  }
  expect(keys[0]).toBeString()
  expect(keys[1]).toBe(keys[0])
  expect(keys[2]).toBe(keys[3])
  expect(keys[2]).not.toBe(keys[0])
})

test('作業領域の課題は、リポジトリのコミットの中身・開発環境の設定・読み取り専用のディレクトリを使う', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hyph-test-'))
  const repo = join(dir, 'repo')
  await Bun.write(join(repo, 'a.txt'), 'old\n')
  await Bun.write(join(repo, '.gitignore'), 'target\n')
  await Bun.$`git -C ${repo} init -q && git -C ${repo} add -A && git -C ${repo} -c user.name=t -c user.email=t@localhost commit -qm a`.quiet()
  const commit = (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim()
  const shared = join(dir, 'shared')
  await Bun.write(join(shared, 'mark'), 'ok')
  await Bun.write(
    join(dir, 'prelude.sh'),
    `export MARK=$(cat ${shared}/mark)\n`,
  )
  const t = task({
    workspace: {
      repo,
      commit,
      prelude: join(dir, 'prelude.sh'),
      mounts: [shared],
    },
    check: 'test "$MARK" = ok && grep -q new a.txt',
    solution: { 'a.txt': 'new\n' },
  })
  expect(await validate(t, always)).toBeNull()
  // 成功した試行の差分には、変更したファイルだけが入り、.gitignore の対象は入らない
  const work = join(dir, 'work')
  await mkdir(work)
  await prepare(work, t)
  await Bun.write(join(work, 'a.txt'), 'new\n')
  await Bun.write(join(work, 'target', 'x'), 'built')
  const patch = await diff(work)
  expect(patch).toContain('+new')
  expect(patch).not.toContain('target')
  await expect(
    prepare(
      join(dir, 'other'),
      task({ workspace: { repo, commit: 'HEAD', prelude: '', mounts: [] } }),
    ),
  ).rejects.toThrow('コミットが不正です')
})

test('作業領域の課題では、生成役が /work でシェルを使い、提出時の変更が模範解答になる', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hyph-test-'))
  const repo = join(dir, 'repo')
  await Bun.write(join(repo, 'a.txt'), 'old\n')
  await Bun.$`git -C ${repo} init -q && git -C ${repo} add -A && git -C ${repo} -c user.name=t -c user.email=t@localhost commit -qm a`.quiet()
  const commit = (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim()
  await Bun.write(join(dir, 'prelude.sh'), '')
  const workspace = {
    repo,
    commit,
    prelude: join(dir, 'prelude.sh'),
    mounts: [],
  }
  const steps: Pick<ToolCall, 'name' | 'arguments'>[] = [
    {
      name: 'sh',
      arguments: { command: 'echo new > a.txt && echo h > hidden.txt' },
    },
    {
      name: 'submit_task',
      arguments: {
        statement: 'a.txt を new にしてください',
        files: {},
        check: 'grep -q new a.txt && test -f hidden.txt',
        check_files: { 'hidden.txt': 'h\n' },
      },
    },
    // 提出のあと /work は元のコミットに戻っている
    { name: 'sh', arguments: { command: 'cat a.txt; ls; echo b > b.txt' } },
    {
      name: 'submit_task',
      arguments: {
        statement: 'b.txt を作ってください',
        files: {},
        check: 'test -f b.txt',
        check_files: {},
      },
    },
  ]
  const contexts: Context[] = []
  const complete: Complete = async (context) => {
    contexts.push(structuredClone(context))
    const step = steps[contexts.length - 1]
    return reply([{ type: 'toolCall', id: String(contexts.length), ...step }])
  }
  const accepted: EvalTask[] = []
  const result = await generate(
    '目的',
    2,
    complete,
    async (t) => {
      const reason = await validate(t, always)
      if (!reason) accepted.push(t)
      return reason
    },
    '',
    workspace,
  )
  expect(result).toEqual({ submitted: 2, accepted: 2 })
  expect(accepted[0].solution).toEqual({ 'a.txt': 'new\n' })
  expect(accepted[1].solution).toEqual({ 'b.txt': 'b\n' })
  expect(accepted[0].workspace).toEqual(workspace)
  expect(JSON.stringify(contexts[3].messages.at(-1))).toContain('old')
  expect(JSON.stringify(contexts[3].messages.at(-1))).not.toContain('hidden')
})

test('不正なファイル名の課題は、生成を止めずに除外の理由として返す', async () => {
  const contexts: Context[] = []
  const complete: Complete = async (context) => {
    contexts.push(structuredClone(context))
    return reply([
      {
        type: 'toolCall',
        id: String(contexts.length),
        name: 'submit_task',
        arguments: { ...task({ check_files: { '.': 'x' } }) },
      },
    ])
  }
  expect(await generate('目的', 1, complete, async () => null)).toEqual({
    submitted: 3,
    accepted: 0,
  })
  expect(JSON.stringify(contexts[1].messages.at(-1))).toContain(
    'ファイル名が不正です: .',
  )
})
