// エージェントの共通の部分。モデルを呼んでツールを動かすループと、その動きを画面へ残す処理
import { readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import type { AssistantMessage, Message, Tool, ToolCall } from '@earendil-works/pi-ai'
import type { AgentStore } from '../shared/contract.ts'
import { ctx, editContext, SHRINK_HINT } from './ctx.ts'
import type { Call } from './topic.ts'

const short = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max)}…` : text)

// ツール結果を文脈に入れる前の長さの上限
const MAX_RESULT = 10_000

// ツール結果の文字列を決まった規則で縮める。連続する同じ行を1行に、連続する空行を1行に詰め、
// 10,000 文字を超える分を後ろから切る
export function shrinkToolResult(text: string) {
  const deduped: string[] = []
  for (const line of text.split('\n')) {
    if (deduped.length > 0 && deduped[deduped.length - 1] === line) continue
    deduped.push(line)
  }
  const lines: string[] = []
  for (const line of deduped) {
    const blank = line.trim() === ''
    if (blank && lines.length > 0 && lines[lines.length - 1].trim() === '') continue
    lines.push(line)
  }
  return lines.join('\n').slice(0, MAX_RESULT)
}

// 応答の文とツールの呼び出しを、動きとして残す
export function noteReply(store: AgentStore, agent: string, reply: AssistantMessage) {
  for (const c of reply.content) {
    if (c.type === 'text' && c.text.trim()) store.act(agent, 'text', short(c.text.trim(), 400))
    if (c.type === 'toolCall') store.act(agent, 'tool', `${c.name} ${short(JSON.stringify(c.arguments))}`)
  }
}

export const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
})

// リポジトリの外を読み書きさせない
export function inside(repo: string, path: unknown) {
  const full = resolve(repo, String(path ?? '.'))
  if (relative(repo, full).startsWith('..')) throw new Error(`リポジトリの外です: ${path}`)
  return full
}

// ponytail: 1ファイルは先頭の 20,000 文字まで。長いファイルを読む必要が出たら範囲の指定を足す
const MAX_FILE = 20_000

export async function listFiles(repo: string, path: unknown) {
  const entries = await readdir(inside(repo, path), { withFileTypes: true })
  return entries
    .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .join('\n')
}

export const readFile = async (repo: string, path: unknown) => (await Bun.file(inside(repo, path)).text()).slice(0, MAX_FILE)

export const READ_TOOLS = [
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
] as Tool[]

// 過去の会話を語で検索するツール。呼んだエージェントの id の SQLite を検索する
export const RECALL_TOOL = {
  name: 'recall',
  description: 'このエージェントの過去のメッセージと要約を語で検索する。一致したメッセージの全文と要約を返す',
  parameters: object(
    {
      query: { type: 'string', description: '検索する語' },
      max_results: { type: 'number', description: '返す件数の上限（既定 5）' },
    },
    ['query'],
  ),
} as Tool

// 文脈ファイルを書き換えるツール。old の1箇所だけを new に置き換える
export const EDIT_CONTEXT_TOOL = {
  name: 'edit_context',
  description: 'このエージェントの文脈ファイルを書き換える。old が1回だけ現れるときその1箇所を new に置き換える',
  parameters: object(
    {
      old: { type: 'string', description: '文脈ファイルにある、置き換える前の文' },
      new: { type: 'string', description: '置き換えた後の文。空文字は不可' },
    },
    ['old', 'new'],
  ),
} as Tool

// recall の結果を文にする。一致が無ければその旨を返す。一致したブロックは参照したものとして数える。
// 文脈のトークン数が上限の 70% を超えているときは、返す文の末尾に縮める指示を添える
export function recall(agent: string, query: unknown, maxResults?: unknown) {
  const n = Number(maxResults)
  const store = ctx(agent)
  // 文脈が上限に近いときだけ、末尾に縮める指示を添える
  const withHint = (text: string) => (store.overLimit() ? `${text}\n${SHRINK_HINT}` : text)
  const found = store.search(String(query ?? ''), Number.isFinite(n) && n > 0 ? n : undefined)
  if (found.messages.length === 0 && found.summaries.length === 0) {
    return withHint('一致するメッセージや要約はありません。')
  }
  for (const message of found.messages) store.markReferenced('生', message.id)
  for (const summary of found.summaries) store.markReferenced('要約', summary.id)
  const lines: string[] = []
  for (const message of found.messages) {
    const inSummaries = message.summaries.length > 0 ? `（要約 ${message.summaries.join(', ')} に含まれる）` : ''
    lines.push(`メッセージ ${message.id}${inSummaries}:\n${message.text}`)
  }
  for (const summary of found.summaries) lines.push(`要約 ${summary.id}:\n${summary.text}`)
  return withHint(lines.join('\n\n'))
}

// 最後の応答のツールの呼び出しのうち、結果のないものに text を結果として返す。API は結果のない呼び出しの後に会話を続けさせない
export function answerPending(messages: Message[], text: string) {
  const last = messages.findLast((m) => m.role === 'assistant') as AssistantMessage | undefined
  const answered = new Set(messages.flatMap((m) => (m.role === 'toolResult' ? [m.toolCallId] : [])))
  for (const c of last?.content ?? []) {
    if (c.type !== 'toolCall' || answered.has(c.id)) continue
    messages.push({
      role: 'toolResult',
      toolCallId: c.id,
      toolName: c.name,
      content: [{ type: 'text', text }],
      isError: false,
      timestamp: Date.now(),
    })
  }
}

// 会話を ctx に追記する関数を返す。追記した位置を覚えておき、同じメッセージは2回追記しない。
// 続きから始める会話は、既に保存されている先頭の分を飛ばす。追記の失敗では例外を出さない
function recorder(agent: string) {
  let store: ReturnType<typeof ctx> | undefined
  let opened = false
  let saved = 0
  return (messages: Message[]) => {
    if (!opened) {
      opened = true
      try {
        store = ctx(agent)
        const stored = store.messages().map((m) => JSON.stringify(m))
        while (saved < stored.length && saved < messages.length && JSON.stringify(messages[saved]) === stored[saved]) saved++
      } catch {
        store = undefined
      }
    }
    if (!store) return
    try {
      for (; saved < messages.length; saved++) store.append(messages[saved])
    } catch {
      // 追記の失敗でエージェントの実行を止めない
    }
  }
}

// 1回の実行のモデルの呼び出しの上限。費用は課題ごとの上限（ADR 0011）で止めるので、これは暴走の止め役に過ぎない。
// 60 回では、irisout の制約を調べながら Monaco を入れる課題（t13）が終わらなかった
const MAX_TURNS = 200

// 要約ノードにまとめず、生のまま残す直近のメッセージの件数
const SUMMARY_KEEP = 8

// 要約ノードを作る間隔（ターン）
const SUMMARY_EVERY = 4

// stop が値を返したツールの呼び出しで、ループを終えてその値を返す
export async function runAgent<T>(options: {
  store: AgentStore
  call: Call
  agent: string
  taskId: string
  system: string
  tools: Tool[]
  messages: Message[]
  run: (call: ToolCall) => Promise<string>
  stop: (call: ToolCall) => T | undefined
}): Promise<T> {
  const { store, call, agent, taskId, system, tools, messages, run, stop } = options
  const save = recorder(agent)
  save(messages)
  // ツールの結果を、縮めてエラーを握る形にする
  const attempt = async (work: () => string | Promise<string>) => {
    try {
      return { text: shrinkToolResult(await work()), isError: false }
    } catch (e) {
      return { text: shrinkToolResult((e as Error).message), isError: true }
    }
  }
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // 毎ターンのモデルの呼び出しの前に文脈ファイルを組み立て、そのパスとブロックごとの状態をシステムプロンプトの末尾に書く
    let systemPrompt = system
    try {
      const context = ctx(agent)
      context.beginTurn()
      const path = context.buildContextFile()
      const lines = context.contextStatus()
      systemPrompt =
        lines.length > 0
          ? `${system}\n文脈ファイル: ${path}\n文脈ブロック:\n${lines.join('\n')}`
          : `${system}\n文脈ファイル: ${path}`
    } catch {
      // 文脈ファイルを作れなくてもエージェントの実行は止めない
    }
    const reply = await call({ topicId: agent, taskId, context: { systemPrompt, messages, tools } })
    messages.push(reply)
    save(messages)
    noteReply(store, agent, reply)
    const calls = reply.content.filter((c): c is ToolCall => c.type === 'toolCall')
    if (calls.length === 0) {
      messages.push({ role: 'user', content: 'ツールを呼んで進めてください。', timestamp: Date.now() })
      save(messages)
    } else {
      for (const toolCall of calls) {
        const result = stop(toolCall)
        if (result !== undefined) return result
        const outcome =
          toolCall.name === 'edit_context'
            ? await attempt(() => {
                const a = toolCall.arguments as Record<string, unknown>
                return editContext(agent, String(a.old ?? ''), String(a.new ?? ''))
              })
            : await attempt(() => run(toolCall))
        store.act(agent, 'result', `${toolCall.name}: ${short(outcome.text.replace(/\s+/g, ' '))}`)
        messages.push({
          role: 'toolResult',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: 'text', text: outcome.text }],
          isError: outcome.isError,
          timestamp: Date.now(),
        })
        save(messages)
      }
    }
    // ターンが終わった後に、4ターンごとに古いメッセージを要約ノードにまとめる。
    // 要約を作れなくてもエージェントの実行は止めない
    if ((turn + 1) % SUMMARY_EVERY === 0) {
      try {
        ctx(agent).summarizeOld(SUMMARY_KEEP)
      } catch {
        // 要約の失敗は握りつぶす
      }
    }
  }
  throw new Error(`${agent} がモデルを ${MAX_TURNS} 回呼んでも終わりませんでした`)
}
