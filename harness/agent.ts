// エージェントの共通の部分。モデルを呼んでツールを動かすループと、その動きを画面へ残す処理
import { readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import type { AssistantMessage, Message, Tool, ToolCall } from '@earendil-works/pi-ai'
import type { AgentStore } from '../shared/contract.ts'
import type { Call } from './topic.ts'

const short = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max)}…` : text)

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

// ponytail: 1回の実行のモデルの呼び出しは 60 回まで。長い課題で足りなくなったら増やす
const MAX_TURNS = 60

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
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const reply = await call({ topicId: agent, taskId, context: { systemPrompt: system, messages, tools } })
    messages.push(reply)
    noteReply(store, agent, reply)
    const calls = reply.content.filter((c): c is ToolCall => c.type === 'toolCall')
    if (calls.length === 0) {
      messages.push({ role: 'user', content: 'ツールを呼んで進めてください。', timestamp: Date.now() })
      continue
    }
    for (const toolCall of calls) {
      const result = stop(toolCall)
      if (result !== undefined) return result
      const outcome = await run(toolCall).then(
        (text) => ({ text, isError: false }),
        (e: Error) => ({ text: e.message, isError: true }),
      )
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
  }
  throw new Error(`${agent} がモデルを ${MAX_TURNS} 回呼んでも終わりませんでした`)
}
