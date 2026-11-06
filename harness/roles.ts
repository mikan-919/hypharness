// 分解役と解答役（改良の対象、ADR 0022）。プロンプト・ツール・ループを持ち、子プロセスとして版ごとに動く。
// 作業ツリーの用意・検査・コミット・差し戻しの回数・保留は固定部（server/pipeline.ts）が持つ
import type { Message, Tool, ToolCall } from '@earendil-works/pi-ai'
import type { AgentStore, DecomposeResult, Job, SolveResult } from '../shared/contract.ts'
import type { Dialog } from '../shared/dialog.ts'
import { answerPending, inside, listFiles, object, READ_TOOLS, readFile, runAgent } from './agent.ts'
import { sandboxed } from './sandbox.ts'
import type { Call } from './topic.ts'

const DECOMPOSE = `あなたは hypharness の分解役です。最終目的の本文と、統合ブランチの今のコードを比べて、次にやる課題を1つだけ課題文にします。

- 最終目的は、会話で渡す FINAL_GOAL.md の本文だけである。完了を判断するのは、この本文に書かれたことを満たしたかどうかだけにする。
- docs/adr の決定は、最終目的の満たし方の制約であって、最終目的ではない。ADR に書かれていて本文に書かれていないことを、課題にしない。
- list_files と read_file で、関係するコードと ADR を読む。
- 課題は submit_task で出す。title に 40 文字以内の題名を付ける。1つの課題は、1回のコミットで終わる大きさにする。変える振る舞い、受け入れの条件、やらないことを書く。
- 解答役の隔離環境にはネットワークがなく、依存を足せない（bun install も動かない）。今の node_modules にない依存が要る課題は出さない。
- 既に終えた課題と同じことは出さない。
- 本文に書かれたことをすべて満たしていると判断したら、課題を出さずに finish を呼ぶ。理由を書く。
- 日本語で書く。修飾表現を使わず、事実を書く。`

const SOLVE = `あなたは hypharness の解答役です。課題文の内容を、作業ツリーのコードに実装します。

- list_files と read_file で読み、write_file で書く。run はコマンドを隔離環境で動かす。隔離環境にはネットワークがない。
- 課題文の受け入れの条件を満たす最小の変更をする。条件に書かれていない機能、抽象化、設定は足さない。
- 終えたら done を呼び、何を変えたかを summary に書く。done の後に検査を動かし、落ちたら出力を返す。
- 依存の追加やネットワークが要るなど、作業ツリーの中だけでは課題を満たせないと分かったら、回避策を作らずに give_up を呼び、理由を書く。
- 日本語で書く。修飾表現を使わず、事実を書く。`

// 経験の一覧に入れる項目の根拠の形。パイプラインが実行の結果から書いた項目だけに合う
const EXECUTION = /^課題 t\d+ の(コミット \S+|検査の終了コード \S+)$/

// プロンプトが課題の数だけ伸びないための上限
const MAX_EXPERIENCE = 20

// 解答役のシステムプロンプトに付ける、共有文脈から作った経験の一覧（ADR 0004）
function experience(dialog: Dialog) {
  const entries = dialog.entries
    .filter((e) => EXECUTION.test(e.evidence))
    .slice(-MAX_EXPERIENCE)
    .reverse()
  if (entries.length === 0) return ''
  const lines = entries.map((e) => `- ${e.kind}: ${e.text.split('\n').join(' / ')}（根拠: ${e.evidence}）`)
  return `\n\n共有文脈から作った経験の一覧（新しい順）:\n${lines.join('\n')}`
}

const DECOMPOSE_TOOLS = [
  ...READ_TOOLS,
  {
    name: 'submit_task',
    description: '次の課題を出す。title はコミットの件名になる',
    parameters: object(
      { title: { type: 'string', description: '40 文字以内の題名' }, statement: { type: 'string' } },
      ['title', 'statement'],
    ),
  },
  {
    name: 'finish',
    description: '最終目的を満たしたときに呼ぶ',
    parameters: object({ reason: { type: 'string' } }, ['reason']),
  },
] as Tool[]

const SOLVE_TOOLS = [
  ...READ_TOOLS,
  {
    name: 'write_file',
    description: '作業ツリーのファイルを content で置き換える。ないファイルは作る',
    parameters: object({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  },
  {
    name: 'run',
    description: 'コマンドを作業ツリーで、隔離環境の中で動かす。ネットワークはない',
    parameters: object({ command: { type: 'string' } }, ['command']),
  },
  {
    name: 'done',
    description: '実装を終えたときに呼ぶ',
    parameters: object({ summary: { type: 'string' } }, ['summary']),
  },
  {
    name: 'give_up',
    description: '作業ツリーの中だけでは課題を満たせないときに呼ぶ。課題は保留になる',
    parameters: object({ reason: { type: 'string' } }, ['reason']),
  },
] as Tool[]

const arg = (call: ToolCall, name: string) => String((call.arguments as Record<string, unknown>)[name] ?? '')

// 分解役に渡すユーザーメッセージ。最終目的の本文、終えた課題、保留にした課題とその理由、保留の割合を入れる（ADR 0010）
function decomposeMessage(dialog: Dialog) {
  const first = (text = '') => text.split('\n')[0]
  const done = dialog.tasks.filter((t) => t.state === 'committed')
  const held = dialog.tasks.filter((t) => t.state === 'held')
  const lines = [
    `最終目的（FINAL_GOAL.md）の本文:\n\n${dialog.goal.text}`,
    `既に終えた課題:\n${done.map((t) => `- ${first(t.statement)}`).join('\n') || '（なし）'}`,
    `保留にした課題:\n${held.map((t) => `- ${t.id}: ${first(t.statement)}（保留の理由: ${first(t.reason)}）`).join('\n') || '（なし）'}`,
  ]
  if (dialog.tasks.length > 0) lines.push(`保留 ${held.length} / 課題 ${dialog.tasks.length}`)
  lines.push('本文をすべて満たしていれば finish を、まだなら次の課題を1つ出してください。')
  return lines.join('\n\n')
}

export async function decompose(store: AgentStore, call: Call, job: Extract<Job, { role: 'decompose' }>) {
  const { tree, taskId } = job
  return runAgent<DecomposeResult>({
    store,
    call,
    agent: 'decompose',
    taskId,
    system: DECOMPOSE,
    tools: DECOMPOSE_TOOLS,
    messages: [{ role: 'user', content: decomposeMessage(await store.snapshot()), timestamp: Date.now() }],
    run: async (c) => (c.name === 'list_files' ? listFiles(tree, arg(c, 'path')) : readFile(tree, arg(c, 'path'))),
    stop: (c) =>
      c.name === 'submit_task'
        ? { statement: `${arg(c, 'title') || arg(c, 'statement').split('\n')[0]}\n\n${arg(c, 'statement')}` }
        : c.name === 'finish'
          ? { finish: arg(c, 'reason') }
          : undefined,
  })
}

// 解答役の1回の試行。前の試行が検査に落ちていたら、その出力を done の結果として返してから続ける
export async function solve(store: AgentStore, call: Call, job: Extract<Job, { role: 'solve' }>): Promise<SolveResult> {
  const { tree, taskId, statement, failure } = job
  const messages: Message[] =
    job.messages.length > 0 ? job.messages : [{ role: 'user', content: `課題 ${taskId}:\n${statement}`, timestamp: Date.now() }]
  if (failure) answerPending(messages, `${failure}\n\n直してから、もう一度 done を呼んでください。`)
  const summary = await runAgent<string>({
    store,
    call,
    agent: 'solve',
    taskId,
    system: SOLVE + experience(await store.snapshot()),
    tools: SOLVE_TOOLS,
    messages,
    run: async (c) => {
      if (c.name === 'list_files') return listFiles(tree, arg(c, 'path'))
      if (c.name === 'read_file') return readFile(tree, arg(c, 'path'))
      if (c.name === 'write_file') {
        await Bun.write(inside(tree, arg(c, 'path')), arg(c, 'content'))
        return `書いた: ${arg(c, 'path')}`
      }
      if (c.name === 'run') {
        const { code, output } = await sandboxed(tree, arg(c, 'command'))
        return `終了コード ${code}\n${output}`
      }
      throw new Error(`未知のツールです: ${c.name}`)
    },
    stop: (c) => {
      if (c.name === 'give_up') throw new Error(`解答役が諦めた: ${arg(c, 'reason')}`)
      return c.name === 'done' ? arg(c, 'summary') : undefined
    },
  })
  return { summary, messages }
}
