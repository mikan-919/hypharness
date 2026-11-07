// エージェントの共通の部分。モデルを呼んでツールを動かすループと、その動きを画面へ残す処理
import { readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import type { AssistantMessage, Message, Tool, ToolCall } from '@earendil-works/pi-ai'
import type { AgentStore } from '../shared/contract.ts'
import { promptTokens, workingContext } from './ctx.ts'
import { AGENT_DIET, COMPRESSION_GUIDE } from './settings.ts'
import type { Call } from './topic.ts'

const short = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max)}…` : text)

// ツール結果の文字列を AGENT_DIET の規則で縮める。連続する同じ行を1行に、連続する空行を1行に詰め、
// toolResultMaxChars 文字を超える分を後ろから切り、切ったことを書き添える
export function shrinkToolResult(text: string) {
  let deduped = text.split('\n')
  if (AGENT_DIET.collapseRepeatedLines) {
    const list: string[] = []
    for (const line of deduped) {
      if (list.length > 0 && list[list.length - 1] === line) continue
      list.push(line)
    }
    deduped = list
  }
  let lines = deduped
  if (AGENT_DIET.collapseBlankLines) {
    const list: string[] = []
    for (const line of deduped) {
      const blank = line.trim() === ''
      if (blank && list.length > 0 && list[list.length - 1].trim() === '') continue
      list.push(line)
    }
    lines = list
  }
  const joined = lines.join('\n')
  const max = AGENT_DIET.toolResultMaxChars
  return joined.length > max ? `${joined.slice(0, max)}\n…（${joined.length} 文字のうち先頭の ${max} 文字）` : joined
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

// 作業文脈に置き換えた会話の原文を語で探すツール（LCM）
export const RECALL_TOOL = {
  name: 'recall',
  description: '作業文脈に置き換えて見えなくなった会話の原文を、語で探す',
  parameters: object(
    {
      query: { type: 'string', description: '探す語。空白で区切ると、どれかを含むものを返す' },
      max_results: { type: 'number', description: '返す件数の上限（既定 5）' },
    },
    ['query'],
  ),
} as Tool

// これまでの会話を、モデルが書いた作業文脈に置き換えるツール（CLM）
export const EDIT_CONTEXT_TOOL = {
  name: 'edit_context',
  description: `ここまでの会話（最初の指示を除く）を content に置き換える。次の呼び出しからは、置き換えた会話の代わりに content だけが渡り、原文は recall で引ける。文脈が長くなり、古いツールの出力が要らなくなったときに呼ぶ。ほかのツールと同じ応答で呼ぶと、それらの結果も置き換えに含まれる。${COMPRESSION_GUIDE}`,
  parameters: object({ content: { type: 'string', description: '作業を続けるのに要ることを書いた作業文脈' } }, ['content']),
} as Tool

// edit_context と recall を作業文脈で処理する。ほかのツールなら undefined を返す
export function contextTool(context: ReturnType<typeof workingContext>, messages: Message[], call: ToolCall) {
  const a = call.arguments as Record<string, unknown>
  if (call.name === 'edit_context') {
    const content = String(a.content ?? '').trim()
    if (!content) throw new Error('content が空のため、置き換えませんでした')
    context.replace(messages, content)
    return '置き換えた。次の呼び出しから、ここまでの会話の代わりに作業文脈を渡す'
  }
  if (call.name === 'recall') {
    const n = Number(a.max_results)
    return context.recall(messages, String(a.query ?? ''), Number.isFinite(n) && n > 0 ? n : undefined)
  }
  return undefined
}

// 文脈がしきい値の半分を超えたら、最後のツールの結果に大きさを書き添える。縮めるかはモデルが決める（CLM）
export function noteSize(messages: Message[], tokens: number) {
  const last = messages.at(-1)
  if (tokens <= AGENT_DIET.compactAtTokens / 2 || last?.role !== 'toolResult') return
  last.content.push({
    type: 'text',
    text: `（文脈は約 ${tokens} トークン。${AGENT_DIET.compactAtTokens} を超えると、古い会話を決まった手順で要約に置き換える。その前に edit_context で自分で縮められる）`,
  })
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

// 1回の実行のモデルの呼び出しの上限。費用は課題ごとの上限（ADR 0011）で止めるので、これは暴走の止め役に過ぎない。
// 60 回では、irisout の制約を調べながら Monaco を入れる課題（t13）が終わらなかった
const MAX_TURNS = 200

// stop が値を返したツールの呼び出しで、ループを終えてその値を返す
export async function runAgent<T>(options: {
  store: AgentStore
  call: Call
  agent: string
  taskId: string
  system: string
  tools: Tool[]
  messages: Message[]
  // 作業文脈を分ける単位。課題の作業ツリーなど、子プロセスをまたいで同じ値になるもの
  contextKey: string
  run: (call: ToolCall) => Promise<string>
  stop: (call: ToolCall) => T | undefined
}): Promise<T> {
  const { store, call, agent, taskId, system, tools, messages, run, stop } = options
  const context = workingContext(options.contextKey)
  let tokens = 0
  // ツールの結果を、縮めてエラーを握る形にする
  const attempt = async (work: () => string | Promise<string>) => {
    try {
      return { text: shrinkToolResult(await work()), isError: false }
    } catch (e) {
      return { text: shrinkToolResult((e as Error).message), isError: true }
    }
  }
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (context.compact(messages, tokens)) store.act(agent, 'text', '文脈がしきい値を超えたため、古い会話を要約に置き換えた')
    const reply = await call({ topicId: agent, taskId, context: { systemPrompt: system, messages: context.view(messages), tools } })
    tokens = promptTokens(reply)
    messages.push(reply)
    noteReply(store, agent, reply)
    const calls = reply.content.filter((c): c is ToolCall => c.type === 'toolCall')
    if (calls.length === 0) {
      messages.push({ role: 'user', content: 'ツールを呼んで進めてください。', timestamp: Date.now() })
    } else {
      for (const toolCall of calls) {
        const result = stop(toolCall)
        if (result !== undefined) return result
        const outcome = await attempt(() => contextTool(context, messages, toolCall) ?? run(toolCall))
        store.act(agent, 'result', `${toolCall.name}: ${short(outcome.text.replace(/\s+/g, ' '))}`)
        messages.push({
          role: 'toolResult',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: 'text', text: outcome.text }],
          isError: outcome.isError,
          timestamp: Date.now(),
        })
      }
      noteSize(messages, tokens)
    }
  }
  throw new Error(`${agent} がモデルを ${MAX_TURNS} 回呼んでも終わりませんでした`)
}
