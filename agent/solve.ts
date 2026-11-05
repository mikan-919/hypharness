// 進化対象のエージェント。候補ごとのこのディレクトリが、隔離環境の /agent に読み取り専用で置かれる。
// 隔離環境には依存パッケージがないため、型と bun の組み込み以外は import しない。モデルは /model.sock の中継を通してだけ呼べる。
// /state は課題をまたいで残る状態のディレクトリ（計測では試行ごとに空）。記憶と、前の課題の成否はここに置く
import { existsSync } from 'node:fs'
import type {
  AssistantMessage,
  Context,
  Message,
  Tool,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai'
import { compact, type LinkKind, openMemory, type Scope } from './memory'

const INSTRUCTIONS =
  'あなたは課題を解くエージェントです。作業用ディレクトリ /work で、sh ツールでコマンドを実行して課題を解いてください。ネットワークには接続できません。' +
  '古いコマンドの出力は、文脈が長くなると原文の番号つきの参照に置き換わります。必要なら expand で戻してください。' +
  '調査や修正の一部を切り出せるときは delegate で子のエージェントに任せると、文脈を短く保てます。' +
  '解き終えたら finish を呼んでください。'
const CHILD_INSTRUCTIONS =
  'あなたは親のエージェントから部分目的を任された子のエージェントです。/work で sh ツールを使って部分目的だけを行い、終えたら finish の summary に、分かったことと変えたファイルを親が次に使える形で書いてください。'
const REFLECT =
  '課題の作業を終えました。次の課題で役立つことがあれば remember で記憶に残してください。対象のリポジトリについての事実は shared、' +
  '自分の進め方の方針や技能は self にします。summary の根拠として、原文（コマンドの出力。番号は「原文 #番号」）からそのまま引用してください。' +
  '残すことがなければ、または残し終えたら finish を呼んでください。'
// ponytail: 1課題でモデルを呼ぶのは子と振り返りの分も合わせて60回まで。費用は中継の予算でも止まる
const MAX_STEPS = 60
const CHILD_STEPS = 20
const REFLECT_STEPS = 3
const OUTPUT_LIMIT = 4000
// ponytail: 入力が16,000トークンを超えたら古い出力を参照に置き換え、直近6件は残す。hibana2 の呼び出しの入力は p90 で約18,000
const CONTEXT_BUDGET = 16_000
const KEEP_RESULTS = 6
// 課題の初めに文脈へ入れる記憶の数
const RECALL = 5
// コマンドは180秒まで。timeout で包み、時間切れのときは子のプロセスごと止める。
// 出力は管ではなくファイルで受け取り、コマンドが終わった時点で読む。管にすると、コマンドが起動したサーバーのように
// 別のプロセスグループで残るプロセスが管を開いたままにし、出力を待ち続ける
const COMMAND_TIMEOUT_SECONDS = 180

const STATE = existsSync('/state') ? '/state' : null
// 前の課題で使った・作った記憶の番号（last.json）と、ノードが判定後に書いたその課題の成否（outcome.json）
const LAST = `${STATE}/last.json`
const OUTCOME = `${STATE}/outcome.json`

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
const rememberTool = {
  name: 'remember',
  description:
    '記憶を残す。gist は1行の要旨、summary は要約、quotes は根拠の [{raw:原文の番号,text:原文からそのままの引用}]、' +
    'links は関係する記憶への [{to:記憶の番号,kind:"task"|"cause"|"depend"}]。要旨がほぼ同じ記憶があればそこへ統合する',
  parameters: object(
    {
      scope: { type: 'string', enum: ['self', 'shared'] },
      gist: { type: 'string' },
      summary: { type: 'string' },
      quotes: { type: 'array', items: { type: 'object' } },
      links: { type: 'array', items: { type: 'object' } },
    },
    ['scope', 'gist', 'summary', 'quotes'],
  ),
}
const finishTool = {
  name: 'finish',
  description: '解き終えたときに呼ぶ。summary に行ったことを書く',
  parameters: object({ summary: { type: 'string' } }),
}

const memory = openMemory(STATE ? `${STATE}/memory.sqlite` : ':memory:')
const goal = await Bun.file('/task.md').text()
// この課題で文脈に入れた記憶と作った記憶。課題の成否で評価する
const touched: number[] = []
let commands = 0
let steps = 0

// 前の課題の成否を、その課題で使った・作った記憶の評価に反映する。成否が届いていなければ（判定のない課題など）評価しない
if (STATE && existsSync(LAST) && existsSync(OUTCOME)) {
  const { ids } = await Bun.file(LAST).json()
  const { ok, cost, limit } = await Bun.file(OUTCOME).json()
  // 予算の上限は基準の2倍なので、上限の半分以下なら基準以下の費用で解けている
  const dropped = memory.judge(ids, ok, limit === null || cost <= limit / 2)
  if (dropped) console.error(`評価の下がった記憶を ${dropped} 件外しました`)
}
if (STATE) {
  await Bun.file(LAST)
    .delete()
    .catch(() => {})
  await Bun.file(OUTCOME)
    .delete()
    .catch(() => {})
}

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

const showEntries = (es: ReturnType<typeof memory.entries>) =>
  es
    .map(
      (e) =>
        `記憶 #${e.id}（${e.scope}、評価 ${e.score}）: ${e.gist}\n${e.summary}`,
    )
    .join('\n---\n')

// 1つの行動ループの作業文脈。refs はツールの呼び出しの id から、結果の原文の番号へ（圧縮で参照に置き換えられる結果だけ）
type Work = {
  context: Context
  refs: Map<string, number>
  depth: number
}

// 1つのツールの呼び出しを実行し、文脈に入れる本文と、原文の番号を返す
async function tool(call: ToolCall, w: Work) {
  const a = call.arguments
  if (call.name === 'sh') {
    const r = await sh(a.command)
    const id = memory.add('sh', r.full, goal)
    return {
      text: `原文 #${id}、終了コード ${r.code}${r.note}\n${page(r.output)}`,
      id,
    }
  }
  if (call.name === 'expand') {
    const row = memory.get(Number(a.id))
    if (!row) throw new Error(`原文 #${a.id} はありません`)
    return { text: page(row.text, Number(a.offset) || 0) }
  }
  if (call.name === 'delegate' && w.depth === 0) {
    if (typeof a.goal !== 'string') throw new Error('goal は文字列です')
    const summary = await loop(a.goal, 1)
    const id = memory.add('delegate', `部分目的: ${a.goal}\n${summary}`, goal)
    return { text: summary, id }
  }
  if (call.name === 'remember') {
    const r = memory.remember({
      scope: a.scope as Scope,
      gist: String(a.gist ?? ''),
      summary: String(a.summary ?? ''),
      quotes: Array.isArray(a.quotes)
        ? a.quotes.map((q: { raw: unknown; text: unknown }) => ({
            raw: Number(q.raw),
            text: String(q.text ?? ''),
          }))
        : [],
      links: Array.isArray(a.links)
        ? a.links.map((l: { to: unknown; kind: unknown }) => ({
            to: Number(l.to),
            kind: l.kind as LinkKind,
          }))
        : [],
    })
    touched.push(r.id)
    return {
      text: r.merged
        ? `既存の記憶 #${r.id} に統合しました`
        : `記憶 #${r.id} として残しました`,
    }
  }
  throw new Error(`未知のツールです: ${call.name}`)
}

// 目的を解く行動ループ。depth 0 が課題を受け取ったエージェント、1 が delegate の子。
// depth 0 では、作業の後に振り返りで記憶を残させる。終えたときの要約を返す
async function loop(target: string, depth: number): Promise<string> {
  // 関連する記憶を選んで、最初のメッセージに入れる（文脈選択）。子には親が渡した部分目的で選ぶ
  const recalled = memory.entries(target, RECALL)
  touched.push(...recalled.map((e) => e.id))
  const shown = showEntries(recalled)
  const w: Work = {
    context: {
      systemPrompt: depth === 0 ? INSTRUCTIONS : CHILD_INSTRUCTIONS,
      messages: [
        {
          role: 'user',
          content: shown
            ? `${target}\n\n## 過去の課題から残した記憶\n${shown}`
            : target,
          timestamp: Date.now(),
        },
      ],
      tools: (depth === 0
        ? [shTool, expandTool, delegateTool, finishTool]
        : [shTool, expandTool, finishTool]) as unknown as Tool[],
    },
    refs: new Map(),
    depth,
  }
  const summary = await act(w, depth === 0 ? MAX_STEPS : CHILD_STEPS)
  if (depth === 0 && STATE) {
    // 振り返り（通常の記憶更新）。同じ文脈のまま、記憶を残すツールだけを渡す
    w.context.messages.push({
      role: 'user',
      content: REFLECT,
      timestamp: Date.now(),
    })
    w.context.tools = [rememberTool, finishTool] as unknown as Tool[]
    await act(w, REFLECT_STEPS)
  }
  return summary
}

// モデルを呼び、ツールを実行するのを、finish かツールを呼ばない応答まで繰り返す
async function act(w: Work, limit: number) {
  const messages: Message[] = w.context.messages
  for (let own = 0; own < limit; own++) {
    if (steps >= MAX_STEPS) break
    steps++
    const response = await fetch('http://model/', {
      method: 'POST',
      unix: '/model.sock',
      body: JSON.stringify(w.context),
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
    messages.push(reply)
    const calls = reply.content.filter(
      (block): block is ToolCall => block.type === 'toolCall',
    )
    const said = reply.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
    // ツールを呼ばずに答えたときも終える。解けたかは判定コマンドが決める
    if (!calls.length) return said
    const finish = calls.find((c) => c.name === 'finish')
    for (const call of calls) {
      let text: string
      let isError = false
      try {
        if (call === finish) text = '終了します'
        else {
          const r = await tool(call, w)
          text = r.text
          if (r.id !== undefined) w.refs.set(call.id, r.id)
        }
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
      messages.push(result)
    }
    if (finish) return String(finish.arguments.summary ?? said)
    const used = reply.usage.input + reply.usage.cacheRead + reply.usage.output
    if (used > CONTEXT_BUDGET) compact(messages, w.refs, KEEP_RESULTS)
  }
  console.error(`モデルの呼び出しが上限に達しました（${steps} 回）`)
  return '（呼び出しの上限に達したため、途中で止めました）'
}

await loop(goal, 0)
if (STATE) await Bun.write(LAST, JSON.stringify({ ids: [...new Set(touched)] }))
