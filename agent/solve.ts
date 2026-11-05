// 進化対象のエージェント。候補ごとのこのディレクトリが、隔離環境の /agent に読み取り専用で置かれる。
// 隔離環境には依存パッケージがないため、型と bun の組み込み以外は import しない。モデルは /model.sock の中継を通してだけ呼べる
import type {
  AssistantMessage,
  Context,
  Tool,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai'
import { compact, openRaw } from './memory'

const INSTRUCTIONS =
  'あなたは課題を解くエージェントです。作業用ディレクトリ /work で、sh ツールでコマンドを実行して課題を解いてください。ネットワークには接続できません。' +
  '古いコマンドの出力は、文脈が長くなると原文の番号つきの参照に置き換わります。必要なら expand で戻し、recall で過去の出力を検索してください。' +
  '調査や修正の一部を切り出せるときは delegate で子のエージェントに任せると、文脈を短く保てます。解き終えたら finish を呼んでください。'
const CHILD_INSTRUCTIONS =
  'あなたは親のエージェントから部分目的を任された子のエージェントです。/work で sh ツールを使って部分目的だけを行い、終えたら finish の summary に、分かったことと変えたファイルを親が次に使える形で書いてください。'
// ponytail: 1課題でモデルを呼ぶのは子の分も合わせて60回まで。費用は中継の予算でも止まる
const MAX_STEPS = 60
const CHILD_STEPS = 20
const OUTPUT_LIMIT = 4000
// ponytail: 入力が16,000トークンを超えたら古い出力を参照に置き換え、直近6件は残す。hibana2 の呼び出しの入力は p90 で約18,000
const CONTEXT_BUDGET = 16_000
const KEEP_RESULTS = 6
// コマンドは180秒まで。timeout で包み、時間切れのときは子のプロセスごと止める。
// 出力は管ではなくファイルで受け取り、コマンドが終わった時点で読む。管にすると、コマンドが起動したサーバーのように
// 別のプロセスグループで残るプロセスが管を開いたままにし、出力を待ち続ける
const COMMAND_TIMEOUT_SECONDS = 180

const object = (properties: object, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
})
const shTool = {
  name: 'sh',
  description:
    '/work で sh -c を実行し、終了コードと出力（標準出力と標準エラー）を返す',
  parameters: object({ command: { type: 'string' } }, ['command']),
}
const recallTool = {
  name: 'recall',
  description:
    'これまでのコマンドと出力の原文を文字列で検索し、番号と抜粋を返す',
  parameters: object({ query: { type: 'string' } }, ['query']),
}
const expandTool = {
  name: 'expand',
  description: '原文の番号の本文を、offset 文字目から返す',
  parameters: object({ id: { type: 'number' }, offset: { type: 'number' } }, [
    'id',
  ]),
}
const delegateTool = {
  name: 'delegate',
  description:
    '部分目的を、新しい文脈の子のエージェントに任せ、その要約を返す。子も /work で sh を使える',
  parameters: object({ goal: { type: 'string' } }, ['goal']),
}
const finishTool = {
  name: 'finish',
  description: '解き終えたときに呼ぶ。summary に行ったことを書く',
  parameters: object({ summary: { type: 'string' } }),
}

const raw = openRaw()
let commands = 0
let steps = 0

async function sh(command: unknown) {
  if (typeof command !== 'string') throw new Error('command は文字列です')
  const file = Bun.file(`/tmp/sh-${++commands}.out`)
  const child = Bun.spawn(
    [
      'timeout',
      '-k',
      '5',
      String(COMMAND_TIMEOUT_SECONDS),
      'sh',
      '-c',
      `exec 2>&1\n${command}`,
    ],
    { cwd: '/work', stdout: file },
  )
  const code = await child.exited
  const output = await file.text()
  await file.delete()
  // timeout は時間切れのとき終了コード124を返す
  const note =
    code === 124 ? `（${COMMAND_TIMEOUT_SECONDS}秒の時間切れで止めました）` : ''
  return {
    full: `$ ${command}\n終了コード ${code}${note}\n${output}`,
    code,
    note,
    output,
  }
}

const page = (text: string, offset = 0) =>
  text.length - offset > OUTPUT_LIMIT
    ? `${text.slice(offset, offset + OUTPUT_LIMIT)}\n（${text.length}文字のうち ${offset}〜${offset + OUTPUT_LIMIT} 文字目）`
    : text.slice(offset)

// 1つのツールの呼び出しを実行し、文脈に入れる本文と、原文の番号を返す
async function tool(call: ToolCall, depth: number) {
  const a = call.arguments
  if (call.name === 'sh') {
    const r = await sh(a.command)
    const id = raw.add('sh', r.full)
    return {
      text: `原文 #${id}、終了コード ${r.code}${r.note}\n${page(r.output)}`,
      id,
    }
  }
  if (call.name === 'recall') {
    if (typeof a.query !== 'string') throw new Error('query は文字列です')
    const hits = raw.search(a.query)
    return {
      text: hits.length
        ? hits.map((h) => `#${h.id}（${h.kind}）: ${h.excerpt}`).join('\n---\n')
        : '見つかりません',
    }
  }
  if (call.name === 'expand') {
    const row = raw.get(Number(a.id))
    if (!row) throw new Error(`原文 #${a.id} はありません`)
    return { text: page(row.text, Number(a.offset) || 0) }
  }
  if (call.name === 'delegate' && depth === 0) {
    if (typeof a.goal !== 'string') throw new Error('goal は文字列です')
    const summary = await loop(a.goal, 1)
    const id = raw.add('delegate', `部分目的: ${a.goal}\n${summary}`)
    return { text: summary, id }
  }
  throw new Error(`未知のツールです: ${call.name}`)
}

// 目的を解く行動ループ。depth 0 が課題を受け取ったエージェント、1 が delegate の子。終えたときの要約を返す
async function loop(goal: string, depth: number): Promise<string> {
  const context: Context = {
    systemPrompt: depth === 0 ? INSTRUCTIONS : CHILD_INSTRUCTIONS,
    messages: [{ role: 'user', content: goal, timestamp: Date.now() }],
    tools: (depth === 0
      ? [shTool, recallTool, expandTool, delegateTool, finishTool]
      : [shTool, recallTool, expandTool, finishTool]) as unknown as Tool[],
  }
  // ツールの呼び出しの id から、結果の原文の番号へ。圧縮で参照に置き換えられる結果だけを持つ
  const refs = new Map<string, number>()
  const limit = depth === 0 ? MAX_STEPS : CHILD_STEPS
  for (let own = 0; own < limit; own++) {
    if (steps >= MAX_STEPS) break
    steps++
    const response = await fetch('http://model/', {
      method: 'POST',
      unix: '/model.sock',
      body: JSON.stringify(context),
      // 中継は一時的な障害のとき待って呼び直すため、5分を超えて応答しないことがある。Bun の既定の無通信の上限（5分）を外す
      timeout: false,
    })
    if (!response.ok) {
      // 予算切れ（402）などで呼べなくなっても、それまでの作業で解けているかは判定コマンドが決める
      console.error(
        `モデルを呼べません (${response.status}): ${await response.text()}`,
      )
      return '（モデルを呼べなくなったため、途中で止めました）'
    }
    const reply = (await response.json()) as AssistantMessage
    if (reply.stopReason === 'error') {
      console.error(`モデルの応答が失敗しました: ${reply.errorMessage}`)
      return '（モデルの応答が失敗したため、途中で止めました）'
    }
    context.messages.push(reply)
    const calls = reply.content.filter(
      (block): block is ToolCall => block.type === 'toolCall',
    )
    const text = reply.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
    // ツールを呼ばずに答えたときも終える。解けたかは判定コマンドが決める
    if (!calls.length) return text
    const finish = calls.find((c) => c.name === 'finish')
    if (finish) return String(finish.arguments.summary ?? text)
    for (const call of calls) {
      let text: string
      let isError = false
      try {
        const r = await tool(call, depth)
        text = r.text
        if (r.id !== undefined) refs.set(call.id, r.id)
      } catch (e) {
        text = e instanceof Error ? e.message : String(e)
        isError = true
      }
      const result: ToolResultMessage = {
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text }],
        isError,
        timestamp: Date.now(),
      }
      context.messages.push(result)
    }
    const used = reply.usage.input + reply.usage.cacheRead + reply.usage.output
    if (used > CONTEXT_BUDGET) compact(context.messages, refs, KEEP_RESULTS)
  }
  console.error(`モデルの呼び出しが上限に達しました（${steps} 回）`)
  return '（呼び出しの上限に達したため、途中で止めました）'
}

await loop(await Bun.file('/task.md').text(), 0)
