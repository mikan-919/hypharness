// 論点エージェント。中継を通してモデルを呼び、利用者に1問ずつ聞いて最終目的を詰める（ADR 0003、0012）
import { relative } from 'node:path'
import type { AssistantMessage, Context, Message, Tool, ToolCall } from '@earendil-works/pi-ai'
import type { Edit } from '../shared/dialog.ts'
import { inside, listFiles, noteReply, object, readFile } from './agent.ts'
import { type AgentStore, CostLimitError } from '../shared/contract.ts'

export type Call = (body: { topicId: string; taskId: string; context: Context }) => Promise<AssistantMessage>

// モデルの利用料以外の費用を中継へ知らせる
export type Charge = (body: { topicId: string; taskId: string; costUsd: number }) => Promise<void>


// 中継の Unix ソケットを呼び、流れてくるイベントの最後（done か error）の応答を返す。
// onText には、書いている途中の文（考えている途中の文を含む）を、届くたびにそれまでの全体で渡す
export const relayCall =
  (socket: string, onText?: (topicId: string, text: string) => void): Call =>
  async (body) => {
    const response = await fetch('http://relay/', { unix: socket, method: 'POST', body: JSON.stringify(body) })
    if (!response.ok || !response.body) {
      const error = ((await response.json()) as { error: string }).error
      // 423 は費用の上限による停止。ほかの失敗とは扱いを分ける
      if (response.status === 423) throw new CostLimitError(error)
      throw new Error(error)
    }
    let buffer = ''
    let text = ''
    let last: any = {}
    const decoder = new TextDecoder()
    for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
      const chunk = decoder.decode(bytes, { stream: true })
      const lines = (buffer + chunk).split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines.filter(Boolean)) {
        last = JSON.parse(line)
        if (last.type === 'text_delta' || last.type === 'thinking_delta') onText?.(body.topicId, (text += last.delta))
      }
    }
    if (buffer.trim()) last = JSON.parse(buffer)
    if (last.type === 'error') throw new Error(last.error.errorMessage ?? 'モデルの呼び出しに失敗しました')
    return last.message
  }

// 中継の /cost を呼び、モデルの利用料以外の費用を知らせる
export const relayCharge =
  (socket: string): Charge =>
  async (body) => {
    const response = await fetch('http://relay/cost', { unix: socket, method: 'POST', body: JSON.stringify(body) })
    if (!response.ok) {
      const error = ((await response.json()) as { error: string }).error
      throw new Error(error)
    }
  }

// 検索1回の費用（ドル）。見積もりで、Parallel の請求額とは一致しない
export const SEARCH_COST = 0.005

const SYSTEM = `あなたは hypharness の論点エージェントです。利用者と一緒に FINAL_GOAL.md（最終目的の本文）を書き換えて、課題に分けられるところまで具体的にします。

- 本文は read_goal で読み、edit_goal で直接書き換える。承認は待たない。書き換えるときは、読んだ版の番号と、書き換えの理由を付ける。断られたら read_goal で読み直してから書き直す。
- 利用者が本文を書き換えると、その差分が会話に届く。利用者の書き換えは意図として扱い、消さない。
- 推奨できる案がある点は、利用者に聞かずに推奨の案で本文を書き換える。利用者は気に入らなければ本文を書き換えて直す。理由は edit_goal の reason に書く。
- 利用者への質問は、推奨の案を決められない点（利用者の好みや事情でしか決まらない点）に限る。ask ツールで1度に1問だけ出す。
- 質問の答えを受け取ったら、次の質問を出す前に、答えを edit_goal で本文に反映する。選択肢を2〜4個付け、推奨する1つを示し、推奨の理由を書く。
- リポジトリを読めば答えが分かることは、list_files と read_file で調べ、利用者に聞かない。
- 外部の情報（外部の文献、API の仕様、既存の実装例）を調べるときは web_search を使う。使った結果を根拠にするときは、record の evidence に URL を書く。ツールの一覧に web_search が無いときは、外部を調べず、リポジトリの中だけを調べる。
- 決まったことは record ツールで kind を done にして残す。根拠（利用者の答えか、ファイルの場所）を evidence に書く。調べて分かった事実は fact、捨てた案は fail で残す。
- 設計上の判断が1つ決まるたびに、write_doc で docs/adr/NNNN-短い英語の名前.md に ADR を書く。番号は既存の ADR の続きにする。形式は「# NNNN 題名」「日付: YYYY-MM-DD」の後に「## 状況」「## 決定」「## 結果」の節を置く。前の決定を変えたときは、その ADR を書き直す。
- 決めた用語は write_doc で docs/glossary.md に「- 用語: 定義」の形で書く。既存の内容を読んでから、全体を書き直す。
- 本文が課題に分けられるところまで具体的になり、決定を ADR に書いたら ready を呼んで終える。ADR を1つも書いていないと ready は断られる。
- 日本語で書く。修飾表現を使わず、事実を書く。`


const WEB_SEARCH: Tool = {
  name: 'web_search',
  description: 'リポジトリに無い情報（外部の文献、API の仕様、既存の実装例）を Web で調べる',
  parameters: object(
    {
      objective: { type: 'string', description: '調べる内容' },
      max_results: { type: 'number', description: '結果の数。既定は 5。1 未満は 1、20 より大きいときは 20 にする' },
    },
    ['objective'],
  ),
}

const TOOLS_BASE = [
  {
    name: 'ask',
    description: '利用者に1問聞き、答えを受け取る',
    parameters: object(
      {
        text: { type: 'string' },
        options: {
          type: 'array',
          items: object(
            { label: { type: 'string' }, description: { type: 'string' }, recommended: { type: 'boolean' } },
            ['label', 'description', 'recommended'],
          ),
        },
        recommendation: { type: 'string', description: '推奨の理由' },
      },
      ['text', 'options', 'recommendation'],
    ),
  },
  {
    name: 'record',
    description: '共有文脈に項目を追記する',
    parameters: object(
      { kind: { type: 'string', enum: ['fact', 'fail', 'done'] }, text: { type: 'string' }, evidence: { type: 'string' } },
      ['kind', 'text', 'evidence'],
    ),
  },
  {
    name: 'list_files',
    description: 'リポジトリのディレクトリの中身を返す',
    parameters: object({ path: { type: 'string', description: 'リポジトリの根からの相対パス' } }, ['path']),
  },
  {
    name: 'read_file',
    description: 'リポジトリのファイルを読む',
    parameters: object({ path: { type: 'string', description: 'リポジトリの根からの相対パス' } }, ['path']),
  },
  { name: 'read_goal', description: 'FINAL_GOAL.md の本文と版の番号を読む', parameters: object({}, []) },
  {
    name: 'edit_goal',
    description: 'FINAL_GOAL.md の全体を content で置き換える。読んだ版の番号を version に付ける。その後に別の書き換えがあれば断られる',
    parameters: object(
      { version: { type: 'number' }, content: { type: 'string' }, reason: { type: 'string', description: '書き換えの理由' } },
      ['version', 'content', 'reason'],
    ),
  },
  {
    name: 'write_doc',
    description: 'ADR か用語集を書く。書けるのは docs/adr/*.md と docs/glossary.md だけ。ファイル全体を content で置き換える',
    parameters: object(
      { path: { type: 'string', description: 'リポジトリの根からの相対パス' }, content: { type: 'string' } },
      ['path', 'content'],
    ),
  },
  { name: 'ready', description: '最終目的が課題に分けられるところまで決まったときに呼ぶ', parameters: object({}, []) },
] as Tool[]

// PARALLEL_API_KEY があるときだけ web_search を加える。呼ぶたびに環境変数を見る
export const TOOLS = (): Tool[] => (process.env.PARALLEL_API_KEY ? [...TOOLS_BASE, WEB_SEARCH] : TOOLS_BASE)

// 検索の結果の文字数の上限。超えた分は後ろを切る
const MAX_SEARCH = 8_000
const SEARCH_URL = 'https://api.parallel.ai/v1beta/search'

// Parallel の Search API を呼び、結果を title・url・抜粋のテキストにする
export async function webSearch(objective: string, maxResults?: number) {
  const key = process.env.PARALLEL_API_KEY
  if (!key) throw new Error('PARALLEL_API_KEY が無いため web_search を呼べません')
  const asked = Number(maxResults ?? 5)
  const max = Number.isFinite(asked) ? Math.min(20, Math.max(1, Math.round(asked))) : 5
  let response: Response
  try {
    response = await globalThis.fetch(SEARCH_URL, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ objective, max_results: max, mode: 'fast' }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    throw new Error(`検索を呼べませんでした: ${(e as Error).message}`)
  }
  if (!response.ok) throw new Error(`検索に失敗しました（HTTP ${response.status}）`)
  let data: any
  try {
    data = await response.json()
  } catch (e) {
    throw new Error(`検索の応答を読み取れませんでした: ${(e as Error).message}`)
  }
  if (!Array.isArray(data?.results)) throw new Error('検索の応答の形が違います: results が配列ではありません')
  const text = data.results
    .map((r: any) => {
      const excerpts = Array.isArray(r?.excerpts) ? r.excerpts.filter((x: unknown) => typeof x === 'string') : []
      return [r?.title, r?.url, ...excerpts].filter((x) => typeof x === 'string' && x !== '').join('\n')
    })
    .join('\n\n')
  if (!text) return '結果なし'
  return text.slice(0, MAX_SEARCH)
}

// 論点エージェントが書けるのは ADR と用語集だけ（読むだけの他のファイルは変えさせない）
const WRITABLE = /^docs\/(adr\/[\w.-]+\.md|glossary\.md)$/

async function run(store: AgentStore, topicId: string, repo: string, call: ToolCall, charge?: Charge) {
  const a = call.arguments as Record<string, any>
  if (call.name === 'ask') {
    const options = Array.isArray(a.options) ? a.options : []
    if (!a.text || options.some((o) => !o?.label || !o?.description)) {
      throw new Error('ask には text と、label・description・recommended を持つ options が要ります')
    }
    const question = { topicId, text: a.text, options, recommendation: a.recommendation, key: call.id }
    return `利用者の答え: ${await store.ask(question)}`
  }
  if (call.name === 'read_goal') {
    const { text, version } = (await store.snapshot()).goal
    store.setSeen(topicId, version)
    return `版 ${version}\n${text}`
  }
  if (call.name === 'edit_goal') {
    const result = await store.editGoal(String(a.content ?? ''), Number(a.version), topicId, String(a.reason ?? ''))
    if (!result.ok) throw new Error(`版 ${a.version} の後に書き換えがありました。read_goal で版 ${result.version} を読み直してください`)
    store.setSeen(topicId, result.version)
    return `書き換えた。今の版は ${result.version}`
  }
  if (call.name === 'write_doc') {
    const full = inside(repo, a.path)
    if (!WRITABLE.test(relative(repo, full))) throw new Error(`書けるのは docs/adr/*.md と docs/glossary.md だけです: ${a.path}`)
    await Bun.write(full, String(a.content ?? ''))
    return `書いた: ${relative(repo, full)}`
  }
  if (call.name === 'record') {
    store.record({ topicId, kind: a.kind, text: a.text, evidence: a.evidence })
    return '追記した'
  }
  if (call.name === 'web_search') {
    if (!a.objective) throw new Error('web_search には objective が要ります')
    let found: string
    try {
      found = await webSearch(a.objective, a.max_results)
    } catch (e) {
      store.record({ topicId, kind: 'fail', text: (e as Error).message, evidence: 'Parallel の検索' })
      throw e
    }
    // 検索が成功したときだけ費用を数える
    await charge?.({ topicId, taskId: 'dialog', costUsd: SEARCH_COST })
    return found
  }
  if (call.name === 'list_files') return listFiles(repo, a.path)
  if (call.name === 'read_file') return readFile(repo, a.path)
  throw new Error(`未知のツールです: ${call.name}`)
}

// 他の書き手（利用者か別の論点）の書き換えを、差分の文章にしてエージェントに渡す
const describe = (edits: Edit[]) =>
  edits
    .map((e) => {
      const lines = e.diff.filter((l) => l.op !== ' ').map((l) => `${l.op} ${l.line}`)
      return `FINAL_GOAL.md が版 ${e.version} に書き換えられた（${e.author === 'user' ? '利用者' : e.author}、理由: ${e.reason}）\n${lines.join('\n')}`
    })
    .join('\n\n')

// ADR を書かずに ready を繰り返すモデルが、費用を使い続けないための上限
const MAX_REFUSED = 3

// ADR 0012: 決定を ADR に書くまで開始のツールを呼ばせない
const wroteAdr = (messages: Message[]) =>
  messages.some(
    (m) => m.role === 'toolResult' && !m.isError && m.content.some((c) => c.type === 'text' && c.text.startsWith('書いた: docs/adr/')),
  )

// 保存した会話があれば続きから始める。最後の応答のツールの呼び出しのうち、結果のないものから処理する
export async function runTopic(store: AgentStore, call: Call, topicId: string, repo: string, charge?: Charge) {
  const messages: Message[] = (await store.transcript(topicId)) ?? [
    { role: 'user', content: 'FINAL_GOAL.md を利用者と一緒に書き換えて、課題に分けられるところまで具体的にしてください。', timestamp: Date.now() },
  ]
  const save = () => store.saveTranscript(topicId, messages)
  let refused = 0
  store.setTopic(topicId, { state: 'researching' })
  try {
    while (true) {
      if (messages.at(-1)?.role !== 'assistant') {
        const edits = await store.editsSince(await store.seen(topicId), topicId)
        if (edits.length > 0) {
          messages.push({ role: 'user', content: describe(edits), timestamp: Date.now() })
          store.setSeen(topicId, (await store.snapshot()).goal.version)
        }
        // ponytail: 対話は1つの課題として費用の上限を受ける。論点が増えたら論点ごとに分ける
        const reply = await call({ topicId, taskId: 'dialog', context: { systemPrompt: SYSTEM, messages, tools: TOOLS() } })
        messages.push(reply)
        noteReply(store, topicId, reply)
        save()
      }
      const reply = messages.at(-1) as AssistantMessage
      const answered = new Set(messages.flatMap((m) => (m.role === 'toolResult' ? [m.toolCallId] : [])))
      const calls = reply.content.filter((c): c is ToolCall => c.type === 'toolCall' && !answered.has(c.id))
      if (calls.length === 0) {
        messages.push({ role: 'user', content: 'ツールで質問するか、ready を呼んでください。', timestamp: Date.now() })
        save()
        continue
      }
      for (const toolCall of calls) {
        if (toolCall.name === 'ready' && wroteAdr(messages)) {
          store.setTopic(topicId, { state: 'ready', ready: true })
          return
        }
        if (toolCall.name === 'ready' && ++refused > MAX_REFUSED) {
          throw new Error(`ADR を書かずに ready を ${MAX_REFUSED} 回より多く呼んだため止めました`)
        }
        if (toolCall.name === 'ask') store.setTopic(topicId, { state: 'asking' })
        const result =
          toolCall.name === 'ready'
            ? { text: '決定を write_doc で ADR に書いてから ready を呼んでください', isError: true }
            : await run(store, topicId, repo, toolCall, charge).then(
                (text) => ({ text, isError: false }),
                (e: Error) => ({ text: e.message, isError: true }),
              )
        store.setTopic(topicId, { state: 'researching' })
        store.act(topicId, 'result', `${toolCall.name}: ${result.text.replace(/\s+/g, ' ').slice(0, 160)}`)
        messages.push({
          role: 'toolResult',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: 'text', text: result.text }],
          isError: result.isError,
          timestamp: Date.now(),
        })
        save()
      }
    }
  } catch (e) {
    store.record({ topicId, kind: 'fail', text: (e as Error).message, evidence: '中継' })
    store.setTopic(topicId, { state: 'blocked' })
  }
}
