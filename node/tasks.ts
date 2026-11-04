// 進化用課題の生成・選別・判定（固定部）。課題文と初期ファイルだけを解答役に渡し、
// 判定用ファイルと模範解答は解答役の隔離環境に置かない
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context, Tool, ToolCall } from '@earendil-works/pi-ai'
import type { Complete } from './model'
import { type Bind, sandbox } from './sandbox'

// ponytail: 判定は5分まで。hibana の判定（ビルドと cargo test）は1分を超えることがある
const CHECK_TIMEOUT_MS = 5 * 60_000
// 生成役に返す判定の出力の上限
const OUTPUT_LIMIT = 1500
// ponytail: 生成役は選別の結果を見て3回まで出し直せる。帯に入る課題が足りなければ増やす
const ROUNDS = 3
// ponytail: 作業領域の課題では、生成役はシェルで調べるため、モデルを100回まで呼べる。課題が揃わなければ増やす
const GENERATE_STEPS = 100
// 生成役のコマンドの上限。sh -c の引数1つは Linux で 128KiB までで、超えると起動が E2BIG で失敗する
const COMMAND_LIMIT = 100_000

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
  // 作業領域。あれば、作業用ディレクトリをこのリポジトリのコミットの中身から作り、その上に files を置く
  workspace?: Workspace
}

export type Workspace = {
  repo: string
  commit: string
  // 隔離環境でコマンドの前に読み込むシェルの設定（nix print-dev-env の出力）
  prelude: string
  // 隔離環境に同じパスで読み取り専用に見せるディレクトリ（依存の取得済みの置き場など）
  mounts: string[]
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

// 課題の作業用ディレクトリを作る。作業領域があれば、そのコミットの中身を1つのコミットにした git のリポジトリとして置く。
// 解答役は git diff で自分の変更を見られ、成功した試行の差分もここから取る。履歴は渡さない（後のコミットに答えがあるため）
export async function prepare(
  dir: string,
  task: Pick<EvalTask, 'files' | 'workspace'>,
) {
  const w = task.workspace
  if (w) {
    if (!/^[0-9a-f]{40}$/.test(w.commit)) {
      throw new Error(`コミットが不正です: ${w.commit}`)
    }
    await Bun.$`git -C ${w.repo} archive ${w.commit} | tar -x -C ${dir}`.quiet()
    await Bun.$`git -C ${dir} init -q && git -C ${dir} add -A && git -C ${dir} -c user.name=hyph -c user.email=hyph@localhost commit -qm base`.quiet()
  }
  await writeFiles(dir, task.files)
}

// 課題の作業領域の設定で、隔離環境のコマンドを作る
export const sandboxFor = (
  workspace: Workspace | undefined,
  dir: string,
  command: string,
  binds: Bind[] = [],
) =>
  sandbox(
    dir,
    command,
    [...binds, ...(workspace?.mounts ?? []).map((p): Bind => [p, p])],
    workspace?.prelude,
  )

// 作業領域の課題で、作業用ディレクトリの変更を差分にする（.gitignore の対象は含まない）
export async function diff(dir: string) {
  await Bun.$`git -C ${dir} add -A`.quiet()
  return (await Bun.$`git -C ${dir} diff --cached`.quiet()).text()
}

// 作業用ディレクトリの複製に判定用ファイルを足し、別の隔離環境で判定コマンドを実行する。
// 解答役が判定用ファイルと同じ名前のファイルを置いていても、判定用ファイルで上書きする
async function check(task: EvalTask, work: string) {
  const dir = await mkdtemp(join(tmpdir(), 'hyph-judge-'))
  try {
    await Bun.$`cp -a ${work}/. ${dir}`.quiet()
    await writeFiles(dir, task.check_files)
    const child = Bun.spawn(
      sandboxFor(task.workspace, dir, `exec 2>&1\n${task.check}`),
      {
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: CHECK_TIMEOUT_MS,
      },
    )
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
    await prepare(dir, task)
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
// 作業領域の課題では、模範解答は引数で受け取らず、生成役が /work に加えた変更から取る
const submitTask = (workspace: boolean) =>
  ({
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
        ...(!workspace && {
          solution: {
            ...files,
            description: `files に重ねると判定を通る模範解答。${files.description}`,
          },
        }),
      },
      required: [
        'statement',
        'files',
        'check',
        'check_files',
        ...(workspace ? [] : ['solution']),
      ],
    },
  }) as unknown as Tool

const shTool = {
  name: 'sh',
  description:
    '/work（課題の作業領域の複製）で sh -c を実行し、終了コードと出力を返す。変更や判定を試すのに使う',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
} as unknown as Tool

// 生成役のシェル。作業領域の設定の隔離環境で実行する
async function shell(workspace: Workspace, work: string, command: unknown) {
  if (typeof command !== 'string') return 'command は文字列です'
  const size = Buffer.byteLength(command)
  if (size > COMMAND_LIMIT) {
    return `コマンドが ${size} バイトで、上限の ${COMMAND_LIMIT} バイトを超えています。ファイルは複数のコマンドに分けて書いてください`
  }
  const child = Bun.spawn(
    sandboxFor(workspace, work, `exec 2>&1\n${command}`),
    { stdout: 'pipe', stderr: 'ignore', timeout: CHECK_TIMEOUT_MS },
  )
  const [output, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ])
  const shown =
    output.length > OUTPUT_LIMIT
      ? `${output.slice(0, OUTPUT_LIMIT)}\n（${output.length}文字のうち先頭${OUTPUT_LIMIT}文字）`
      : output
  return `終了コード ${code}\n${shown}`
}

// 作業用ディレクトリで変更・追加したファイル（exclude のパスを除く）。削除は扱わない
async function changed(dir: string, exclude: Files) {
  await Bun.$`git -C ${dir} add -A`.quiet()
  const paths = (
    await Bun.$`git -C ${dir} diff --cached --name-only --diff-filter=AM`.quiet()
  )
    .text()
    .split('\n')
    .filter((p) => p && !(p in exclude))
  const result: Files = {}
  for (const p of paths) result[p] = await Bun.file(join(dir, p)).text()
  return result
}

const isFiles = (v: unknown): v is Files =>
  typeof v === 'object' &&
  v !== null &&
  Object.values(v).every((x) => typeof x === 'string')

const asTask = (
  args: Record<string, unknown>,
  workspace?: Workspace,
): EvalTask | null =>
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
        ...(workspace && { workspace }),
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
  // 作業領域。あれば課題をこのリポジトリのコミットの上に作り、生成役は /work の複製でシェルを使える
  workspace?: Workspace,
) {
  const environment = workspace
    ? `- 解答役は課題文を見て、ネットワークのない Linux の隔離環境で解きます。/work には、最終目的のリポジトリのコミットの中身（git の1コミット）に files を重ねたものがあります
- あなたは sh ツールで、解答役と同じ環境の /work の複製を調べ、変更を試せます
- 判定は機械で行います。check は終了コード0で成功を表すコマンドにし、隠しテストや期待値は check_files に入れてください。既存のテストも壊していないことを check で確かめてください
- 判定は課題文に書いた要件だけで行ってください。正しい書き方が複数ある細部（エスケープの表記、空白、エラーメッセージの文言など）に依存する判定にするなら、期待する出力を課題文に明記してください
- 何もしない解答では判定を通らないようにしてください
- 提出すると、そのときの /work の変更（check_files のパスを除く）が模範解答になります。提出のあと /work は元のコミットに戻ります（.gitignore の対象は残ります）。1課題ずつ、変更を作り、判定が通ることを確かめてから提出してください`
    : `- 解答役は課題文と files だけを見て、ネットワークのない Linux の隔離環境（sh、coreutils、bun がある）で解きます
- 判定は機械で行います。check は終了コード0で成功を表すコマンドにし、テストや期待値は check_files に入れてください
- 何もしない解答では判定を通らないようにしてください
- solution は files に重ねると判定を通る模範解答です`
  const submit = submitTask(Boolean(workspace))
  const context: Context = {
    systemPrompt:
      'あなたは、AI エージェントのハーネスを評価する課題の作成者です。最終目的の達成に必要な能力を測る課題を作り、submit_task で提出してください。',
    messages: [
      {
        role: 'user',
        content: `最終目的:
${goal}

この最終目的に必要な能力を測る課題を ${count} 個、互いに異なる内容で作ってください。
${environment}${guidance && `\n\n${guidance}`}`,
        timestamp: Date.now(),
      },
    ],
    tools: workspace ? [submit, shTool] : [submit],
  }
  const work = workspace
    ? await mkdtemp(join(tmpdir(), 'hyph-generate-'))
    : null
  if (work) await prepare(work, { files: {}, workspace })
  try {
    return await rounds(
      context,
      count,
      complete,
      accept,
      submit,
      workspace,
      work,
    )
  } finally {
    if (work) await rm(work, { recursive: true, force: true })
  }
}

async function rounds(
  context: Context,
  count: number,
  complete: Complete,
  accept: (task: EvalTask) => Promise<string | null>,
  submit: Tool,
  workspace: Workspace | undefined,
  work: string | null,
) {
  let submitted = 0
  let accepted = 0
  const limit = workspace ? GENERATE_STEPS : ROUNDS
  for (let round = 0; round < limit && accepted < count; round++) {
    const reply = await complete(context)
    context.messages.push(reply)
    const calls = toolCalls(reply)
    // 採用が足りないまま文章だけで応答したときは、除外の理由を踏まえて出し直すよう促す
    if (!calls.length) {
      context.messages.push({
        role: 'user',
        content: `採用はまだ ${accepted}/${count} 個です。除外の理由を踏まえて、submit_task で課題を出し直してください。`,
        timestamp: Date.now(),
      })
      continue
    }
    // シェルと、提出時の /work の変更の取り出しは順に行う。課題の選別は並列に行い、結果は呼び出しの順に返す
    const pending: Promise<{ text: string; isError: boolean }>[] = []
    for (const call of calls) {
      if (call.name === shTool.name && workspace && work) {
        const text = await shell(workspace, work, call.arguments.command)
        pending.push(Promise.resolve({ text, isError: false }))
        continue
      }
      submitted++
      const args = { ...call.arguments }
      if (workspace && work && isFiles(args.check_files)) {
        args.solution = await changed(work, args.check_files)
        await Bun.$`git -C ${work} reset -q --hard && git -C ${work} clean -fdq`.quiet()
      }
      const task = call.name === submit.name ? asTask(args, workspace) : null
      // 不正なファイル名は、生成全体を止めずに除外の理由として返す
      const bad = task
        ? [task.files, task.check_files, task.solution]
            .flatMap(Object.keys)
            .find((p) => !safePath(p))
        : undefined
      pending.push(
        (!task
          ? Promise.resolve('submit_task の引数の形式が不正です')
          : bad !== undefined
            ? Promise.resolve(`ファイル名が不正です: ${bad}`)
            : accept(task)
        ).then((reason) => {
          if (!reason) accepted++
          return {
            text: `${reason ? `除外しました: ${reason}` : '採用しました'}\n採用は ${accepted}/${count} 個です`,
            isError: Boolean(reason),
          }
        }),
      )
    }
    const results = await Promise.all(pending)
    for (const [i, call] of calls.entries()) {
      context.messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: results[i].text }],
        isError: results[i].isError,
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
