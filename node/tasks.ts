// 進化用課題の生成・選別・判定（固定部）。課題文と初期ファイルだけを解答役に渡し、
// 判定用ファイルと模範解答は解答役の隔離環境に置かない
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context, Tool, ToolCall } from '@earendil-works/pi-ai'
import type { Complete } from './model'
import { sandbox } from './sandbox'

const CHECK_TIMEOUT_MS = 60_000
// 生成役に返す判定の出力の上限
const OUTPUT_LIMIT = 1500
// ponytail: 生成役は選別の結果を見て3回まで出し直せる。帯に入る課題が足りなければ増やす
const ROUNDS = 3

export type Split = 'val' | 'test'
type Files = Record<string, string>
export type EvalTask = {
  // 解答役に渡す課題文。判定の方法や正解は書かない
  statement: string
  // 解答役の作業用ディレクトリに最初から置くファイル
  files: Files
  // 判定コマンド。解答役が終えた作業用ディレクトリに check_files を足して実行し、終了コード0なら成功
  check: string
  check_files: Files
  // 模範解答。files に重ねて置くと判定を通るファイル
  solution: Files
}

// 課題のファイル名は、作業用ディレクトリの中を指す相対パスに限る
const safePath = (path: string) =>
  path.split('/').every((s) => /^[\w.-]+$/.test(s) && s !== '.' && s !== '..')

export async function writeFiles(dir: string, files: Files) {
  for (const [path, content] of Object.entries(files)) {
    if (!safePath(path)) throw new Error(`ファイル名が不正です: ${path}`)
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await Bun.write(join(dir, path), content)
  }
}

// 作業用ディレクトリの複製に判定用ファイルを足し、別の隔離環境で判定コマンドを実行する。
// 解答役が判定用ファイルと同じ名前のファイルを置いていても、判定用ファイルで上書きする
async function check(task: EvalTask, work: string) {
  const dir = await mkdtemp(join(tmpdir(), 'hyph-judge-'))
  try {
    await Bun.$`cp -a ${work}/. ${dir}`.quiet()
    await writeFiles(dir, task.check_files)
    const child = Bun.spawn(sandbox(dir, `exec 2>&1\n${task.check}`), {
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: CHECK_TIMEOUT_MS,
    })
    const [output, code] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ])
    return { ok: code === 0, output }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export const judge = async (task: EvalTask, work: string) =>
  (await check(task, work)).ok

async function passes(task: EvalTask, answer: Files) {
  const dir = await mkdtemp(join(tmpdir(), 'hyph-task-'))
  try {
    await writeFiles(dir, task.files)
    await writeFiles(dir, answer)
    return await check(task, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// 表に入れてよい課題なら null、だめなら理由を返す。理由は生成役にも返すため、判定の出力を付ける
export async function validate(
  task: EvalTask,
  relevant: (task: EvalTask) => Promise<boolean>,
): Promise<string | null> {
  const solved = await passes(task, task.solution)
  if (!solved.ok) {
    return `模範解答が判定を通りません。判定の出力（末尾）:\n${solved.output.slice(-OUTPUT_LIMIT)}`
  }
  if ((await passes(task, {})).ok) return '空の解答が判定を通ります'
  if (!(await relevant(task))) return '最終目的に関係しません'
  return null
}

const files = {
  type: 'object',
  additionalProperties: { type: 'string' },
  description: 'パスから内容への対応。パスは作業用ディレクトリからの相対パス',
}
const submitTask = {
  name: 'submit_task',
  description: '課題を1つ提出する。課題の数だけ呼ぶ',
  parameters: {
    type: 'object',
    properties: {
      statement: {
        type: 'string',
        description: '解答役に渡す課題文。判定の方法や正解は書かない',
      },
      files: {
        ...files,
        description: `解答役に最初から渡すファイル。${files.description}`,
      },
      check: {
        type: 'string',
        description:
          '判定コマンド。作業用ディレクトリで sh -c で実行し、終了コード0なら成功',
      },
      check_files: {
        ...files,
        description: `判定にだけ使い、解答役には見せないファイル（テストなど）。${files.description}`,
      },
      solution: {
        ...files,
        description: `files に重ねると判定を通る模範解答。${files.description}`,
      },
    },
    required: ['statement', 'files', 'check', 'check_files', 'solution'],
  },
} as unknown as Tool

const isFiles = (v: unknown): v is Files =>
  typeof v === 'object' &&
  v !== null &&
  Object.values(v).every((x) => typeof x === 'string')

const asTask = (args: Record<string, unknown>): EvalTask | null =>
  typeof args.statement === 'string' &&
  typeof args.check === 'string' &&
  isFiles(args.files) &&
  isFiles(args.check_files) &&
  isFiles(args.solution)
    ? {
        statement: args.statement,
        files: args.files,
        check: args.check,
        check_files: args.check_files,
        solution: args.solution,
      }
    : null

const toolCalls = (reply: Awaited<ReturnType<Complete>>) =>
  reply.content.filter((b): b is ToolCall => b.type === 'toolCall')

// 最終目的の文章から課題を作らせる。提出のたびに accept で選別し、その結果をツールの結果として返す。
// 生成役は除外の理由（判定の出力や基準版の解けた割合）を見て出し直せる。
// accept は採用なら null、除外なら生成役に返す理由を返す。guidance には、敵対的強化のときに基準版の成績と失敗の記録を渡す
export async function generate(
  goal: string,
  count: number,
  complete: Complete,
  accept: (task: EvalTask) => Promise<string | null>,
  guidance = '',
) {
  const context: Context = {
    systemPrompt:
      'あなたは、AI エージェントのハーネスを評価する課題の作成者です。最終目的の達成に必要な能力を測る課題を作り、submit_task で提出してください。',
    messages: [
      {
        role: 'user',
        content: `最終目的:
${goal}

この最終目的に必要な能力を測る課題を ${count} 個、互いに異なる内容で作ってください。
- 解答役は課題文と files だけを見て、ネットワークのない Linux の隔離環境（sh、coreutils、bun がある）で解きます
- 判定は機械で行います。check は終了コード0で成功を表すコマンドにし、テストや期待値は check_files に入れてください
- 何もしない解答では判定を通らないようにしてください
- solution は files に重ねると判定を通る模範解答です${guidance && `\n\n${guidance}`}`,
        timestamp: Date.now(),
      },
    ],
    tools: [submitTask],
  }
  let submitted = 0
  let accepted = 0
  for (let round = 0; round < ROUNDS && accepted < count; round++) {
    const reply = await complete(context)
    context.messages.push(reply)
    const calls = toolCalls(reply)
    if (!calls.length) break
    for (const call of calls) {
      const task = call.name === submitTask.name ? asTask(call.arguments) : null
      const reason = task
        ? await accept(task)
        : 'submit_task の引数の形式が不正です'
      submitted++
      if (!reason) accepted++
      context.messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [
          {
            type: 'text',
            text: `${reason ? `除外しました: ${reason}` : '採用しました'}\n採用は ${accepted}/${count} 個です`,
          },
        ],
        isError: Boolean(reason),
        timestamp: Date.now(),
      })
    }
  }
  return { submitted, accepted }
}

const verdict = {
  name: 'verdict',
  description: '判定を返す',
  parameters: {
    type: 'object',
    properties: {
      relevant: { type: 'boolean' },
      reason: { type: 'string' },
    },
    required: ['relevant', 'reason'],
  },
} as unknown as Tool

// 課題が最終目的に関係するかを、生成とは別の呼び出しで判定させる
export async function relevance(
  goal: string,
  task: EvalTask,
  complete: Complete,
) {
  const reply = await complete({
    systemPrompt:
      'あなたは評価課題の審査役です。課題が最終目的の達成に必要な能力を測るものかを判定し、verdict で返してください。',
    messages: [
      {
        role: 'user',
        content: `最終目的:\n${goal}\n\n課題文:\n${task.statement}\n\n判定コマンド:\n${task.check}`,
        timestamp: Date.now(),
      },
    ],
    tools: [verdict],
  })
  return toolCalls(reply).some(
    (c) => c.name === verdict.name && c.arguments.relevant === true,
  )
}
